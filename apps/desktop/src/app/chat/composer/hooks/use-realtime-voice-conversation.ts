// Full-duplex realtime dialogue for the desktop voice dock.
//
// One WebSocket + one mic stream for the whole conversation: PCM flows up
// continuously (silence included), the server's VAD decides when the user
// turn ends, and assistant PCM flows back while the mic keeps listening.

import { useCallback, useEffect, useRef, useState } from 'react'

import { speakText } from '@/hermes'
import { acquireCapture } from '@/lib/audio-capture-engine'
import { startPcmCapture } from '@/lib/pcm-capture'
import { type RealtimeDialogueSession, startRealtimeDialogue } from '@/lib/realtime-dialogue'
import { pcmRms, SpeechEnergyDetector } from '@/lib/voice-energy'
import { emit, endTurn, startTurn, VOICE_EVENT } from '@/lib/voice-metrics'
import { playLocalSpeechStreaming, stopVoicePlayback } from '@/lib/voice-playback'
import {
  isVoiceDictationCommand,
  isVoicePauseCommand,
  isVoiceResumeCommand,
  isVoiceStopCommand,
  normalizeBotName
} from '@/lib/voice-stop-word'
import { takeWakeGreeting } from '@/store/composer'
import { notify, notifyError } from '@/store/notifications'

async function playLocalSpeech(text: string): Promise<void> {
  try {
    try {
      if (await playLocalSpeechStreaming(text)) {
        return
      }
    } catch {
      // Streaming unavailable; fall through to the POST data-URL path.
    }

    const response = await speakText(text)

    if (!response?.ok || !response.data_url) {
      return
    }

    const audio = new Audio(response.data_url)
    await audio.play()
  } catch {
    // Best-effort local confirmation; never break the voice loop.
  }
}

function estimateSpokenChars(text: string, playedSeconds: number): number {
  if (!text || playedSeconds <= 0) {
    return 0
  }

  // Approximate spoken progress at the configured 1.1x TTS speed. Deliberately
  // conservative: replaying a syllable or two is better than swallowing words.
  const chars = Math.floor(playedSeconds * 3.2)

  return Math.max(0, Math.min(text.length, chars))
}

const PAUSE_CONFIRMATIONS = [
  '\u597d\u7684\uff0c\u4f60\u8bf4',
  '\u597d\u7684\uff0c\u9a6c\u54e5',
  '\u597d\u7684'
]

// Spoken answer to the wake word: 马哥 asked for 小赫 to say "在呢，马哥" instead of
// only chiming. Doubao voices it (ChatTTSText) so the wording is exact and the
// audio rides the realtime dialogue stream.
const WAKE_ACKS = ['\u5728\u5462\uff0c\u9a6c\u54e5', '\u6211\u5728\uff0c\u9a6c\u54e5', '\u55ef\uff0c\u9a6c\u54e5', '\u5728\u5462']

export type RealtimeConversationStatus = 'idle' | 'listening' | 'thinking' | 'speaking'

export interface RealtimeVoiceConversationOptions {
  enabled: boolean
  sessionId?: string | null
  onFatalError?: () => void
  onStopWord?: () => void
  /** Dictation-mode target: append a recognized sentence to the composer draft
   *  without submitting a turn or speaking a reply. */
  onDictationText?: (text: string) => void
  /** Awaited before the mic is opened (wake-word listener release, etc.). */
  beforeMicOpen?: () => Promise<void> | void
}

export function useRealtimeVoiceConversation({
  enabled,
  sessionId,
  onFatalError,
  onStopWord,
  onDictationText,
  beforeMicOpen
}: RealtimeVoiceConversationOptions) {
  const [status, setStatus] = useState<RealtimeConversationStatus>('idle')
  const [level, setLevel] = useState(0)
  const [muted, setMuted] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [replyText, setReplyText] = useState('')

  const statusRef = useRef<RealtimeConversationStatus>('idle')
  const enabledRef = useRef(enabled)
  const sessionIdRef = useRef(sessionId)
  const wasEnabledRef = useRef(enabled)
  const mutedRef = useRef(muted)
  const beforeMicOpenRef = useRef(beforeMicOpen)
  const stoppingRef = useRef(false)
  const onStopWordRef = useRef(onStopWord)
  const onDictationTextRef = useRef(onDictationText)
  const dictationRef = useRef(false)
  const dictationPausedRef = useRef(false)
  const sessionRef = useRef<RealtimeDialogueSession | null>(null)
  const captureStopRef = useRef<(() => void) | null>(null)
  const meterStopRef = useRef<(() => void) | null>(null)
  const leaseRef = useRef<{ release: () => void } | null>(null)
  const metricsTurnCounterRef = useRef(0)
  const metricsTurnOpenRef = useRef(false)
  const metricsSpeechStartedRef = useRef(false)
  const metricsSttFinalRef = useRef(false)
  const metricsFirstTextRef = useRef(false)
  const localVadRef = useRef<SpeechEnergyDetector | null>(null)
  const localBargeFiredRef = useRef(false)
  const replyTextRef = useRef('')
  const pausedReplyRef = useRef<string | null>(null)
  const pausedOffsetRef = useRef(0)
  const commandHandledRef = useRef<'dictation' | 'pause' | 'stop' | null>(null)
  const turnResumeHandledRef = useRef(false)
  const startListeningRef = useRef<() => void>(() => undefined)

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref writes (mirror useVoiceConversation)
  useEffect(() => {
    onStopWordRef.current = onStopWord
  }, [onStopWord])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref write (see eslint rule comment)
  useEffect(() => {
    onDictationTextRef.current = onDictationText
  }, [onDictationText])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref writes (mirror useVoiceConversation)
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref writes (mirror useVoiceConversation)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref writes (mirror useVoiceConversation)
  useEffect(() => {
    mutedRef.current = muted
  }, [muted])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref writes (mirror useVoiceConversation)
  useEffect(() => {
    beforeMicOpenRef.current = beforeMicOpen
  }, [beforeMicOpen])

  // eslint-disable-next-line no-restricted-syntax -- legitimate non-atom ref writes (mirror useVoiceConversation)
  useEffect(() => {
    statusRef.current = status
  }, [status])

  const cleanupCapture = useCallback(() => {
    meterStopRef.current?.()
    meterStopRef.current = null
    captureStopRef.current?.()
    captureStopRef.current = null
    leaseRef.current?.release()
    leaseRef.current = null
  }, [])

  const startMeter = useCallback(
    (stream: MediaStream) => {
      const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
      const Ctor = window.AudioContext || audioWindow.webkitAudioContext

      if (!Ctor) {
        return () => undefined
      }

      const context = new Ctor()
      const analyser = context.createAnalyser()
      const source = context.createMediaStreamSource(stream)
      analyser.fftSize = 256
      const data = new Uint8Array(analyser.fftSize)
      source.connect(analyser)

      let frame: number | null = null

      const tick = () => {
        analyser.getByteTimeDomainData(data)

        let sum = 0

        for (const value of data) {
          const centered = value - 128
          sum += centered * centered
        }

        const rms = Math.sqrt(sum / data.length)
        const normalized = Math.min(1, rms / 42)

        setLevel(normalized)

        frame = window.requestAnimationFrame(tick)
      }

      tick()

      return () => {
        if (frame !== null) {
          window.cancelAnimationFrame(frame)
          frame = null
        }

        try {
          source.disconnect()
        } catch {
          // already disconnected
        }

        void context.close().catch(() => undefined)
      }
    },
    []
  )

  const openRealtimeMetricsTurn = useCallback((withMicOpen: boolean) => {
    metricsTurnCounterRef.current += 1
    startTurn(`realtime-${metricsTurnCounterRef.current}`)
    metricsTurnOpenRef.current = true
    metricsSpeechStartedRef.current = false
    metricsSttFinalRef.current = false
    metricsFirstTextRef.current = false

    if (withMicOpen) {
      emit(VOICE_EVENT.MIC_OPEN, { source: 'realtime' })
    }
  }, [])

  const closeRealtimeMetricsTurn = useCallback(() => {
    if (!metricsTurnOpenRef.current) {
      return
    }

    metricsTurnOpenRef.current = false
    metricsSpeechStartedRef.current = false
    metricsSttFinalRef.current = false
    metricsFirstTextRef.current = false
    endTurn()
  }, [])

  const startListening = useCallback(async () => {
    if (!enabledRef.current || mutedRef.current || stoppingRef.current || statusRef.current !== 'idle') {
      return
    }

    try {
      await beforeMicOpenRef.current?.()
    } catch {
      // A pause failure shouldn't block the user's explicit start.
    }

    // The realtime path owns its own AudioContext. Clear any stale segmented
    // / read-aloud playback state so the old "preparing / speaking" pill can
    // never linger on screen or overlap the dialogue stream.
    stopVoicePlayback()
    localVadRef.current = new SpeechEnergyDetector({ minTriggerLevel: 0.06, sustainedChunks: 2 })
    localBargeFiredRef.current = false
    pausedReplyRef.current = null
    pausedOffsetRef.current = 0
    commandHandledRef.current = null
    turnResumeHandledRef.current = false
    dictationRef.current = false
    dictationPausedRef.current = false
    setTranscript('')
    setReplyText('')
    setStatus('listening')

    try {
      let session = sessionRef.current

      if (!session) {
        session = await startRealtimeDialogue({
          sessionId: sessionIdRef.current,
          onAsr: (text, final) => {
            if (text) {
              setTranscript(normalizeBotName(text))

              if (!metricsTurnOpenRef.current) {
                metricsTurnCounterRef.current += 1
                startTurn(`realtime-${metricsTurnCounterRef.current}`)
                metricsTurnOpenRef.current = true
                metricsSttFinalRef.current = false
                metricsFirstTextRef.current = false
              }

              if (!metricsSpeechStartedRef.current) {
                metricsSpeechStartedRef.current = true
                emit(VOICE_EVENT.SPEECH_START, { source: 'realtime' })
              }

              if (isVoicePauseCommand(text) && commandHandledRef.current !== 'pause') {
                commandHandledRef.current = 'pause'
                stopVoicePlayback()
                const played = sessionRef.current?.interruptPlayback() ?? 0
                sessionRef.current?.suppressReplyAudioUntilEnd()
                pausedReplyRef.current = replyTextRef.current
                pausedOffsetRef.current = Math.max(0, estimateSpokenChars(replyTextRef.current, played) - 3)

                const confirmation =
                  PAUSE_CONFIRMATIONS[Math.floor(Math.random() * PAUSE_CONFIRMATIONS.length)]!

                void playLocalSpeech(confirmation)
              }
            }

            if (final && text) {
              if (isVoiceDictationCommand(text) && commandHandledRef.current !== 'dictation') {
                commandHandledRef.current = 'dictation'
                dictationRef.current = true
                dictationPausedRef.current = false
                notify({
                  id: 'voice-dictation',
                  kind: 'info',
                  icon: 'mic',
                  message: '听写模式：说"停"暂停，说"继续"恢复，说"退出"结束'
                })
                stopVoicePlayback()
                sessionRef.current?.suppressReplyAudioUntilEnd()

                return
              }

              if (dictationRef.current) {
                if (isVoiceStopCommand(text)) {
                  dictationRef.current = false
                  dictationPausedRef.current = false
                  commandHandledRef.current = 'stop'
                  closeRealtimeMetricsTurn()
                  onStopWordRef.current?.()

                  return
                }

                if (isVoicePauseCommand(text)) {
                  dictationPausedRef.current = true
                  commandHandledRef.current = 'dictation'
                  notify({
                    id: 'voice-dictation',
                    kind: 'info',
                    icon: 'mic',
                    message: '听写已暂停，说"继续"恢复'
                  })

                  return
                }

                if (isVoiceResumeCommand(text)) {
                  dictationPausedRef.current = false
                  commandHandledRef.current = 'dictation'
                  notify({
                    id: 'voice-dictation',
                    kind: 'info',
                    icon: 'mic',
                    message: '继续听写'
                  })

                  return
                }

                // 暂停时忽略普通语音；未暂停时把识别句追加进输入框。
                if (!dictationPausedRef.current) {
                  onDictationTextRef.current?.(text)
                }

                stopVoicePlayback()
                sessionRef.current?.suppressReplyAudioUntilEnd()

                return
              }

              const stop = isVoiceStopCommand(text)
              const pause = isVoicePauseCommand(text)

              if (stop && commandHandledRef.current !== 'stop') {
                commandHandledRef.current = 'stop'
                closeRealtimeMetricsTurn()
                onStopWordRef.current?.()

                return
              }

              if (pause) {
                if (commandHandledRef.current !== 'pause') {
                  commandHandledRef.current = 'pause'
                  stopVoicePlayback()
                  const played = sessionRef.current?.interruptPlayback() ?? 0
                  sessionRef.current?.suppressReplyAudioUntilEnd()
                  pausedReplyRef.current = replyTextRef.current
                  pausedOffsetRef.current = Math.max(
                    0,
                    estimateSpokenChars(replyTextRef.current, played) - 3
                  )

                  const confirmation =
                    PAUSE_CONFIRMATIONS[Math.floor(Math.random() * PAUSE_CONFIRMATIONS.length)]!

                  void playLocalSpeech(confirmation)
                }
              }

              if (commandHandledRef.current === 'stop') {
                return
              }

              if (commandHandledRef.current === 'pause' && !pause) {
                commandHandledRef.current = null
              }

              if (isVoiceResumeCommand(text)) {
                const paused = pausedReplyRef.current

                if (paused) {
                  const pausedOffset = pausedOffsetRef.current

                  const latest =
                    replyTextRef.current.length > paused.length ? replyTextRef.current : paused

                  replyTextRef.current = ''
                  pausedReplyRef.current = null
                  pausedOffsetRef.current = 0
                  sessionRef.current?.suppressReplyAudioUntilEnd()

                  const remaining = latest.slice(pausedOffset).trim()

                  if (remaining) {
                    void playLocalSpeech(remaining)
                  }
                }
              } else if (commandHandledRef.current !== 'pause') {
                // A real follow-up supersedes any paused-reading state.
                if (!turnResumeHandledRef.current) {
                  turnResumeHandledRef.current = true
                  sessionRef.current?.resumeReplyAudio()
                  sessionRef.current?.interruptPlayback()
                  replyTextRef.current = ''
                  pausedReplyRef.current = null
                  pausedOffsetRef.current = 0
                }
              }

              if (!metricsSttFinalRef.current) {
                metricsSttFinalRef.current = true
                emit(VOICE_EVENT.STT_FINAL, { len: text.length, source: 'realtime' })
              }
            }
          },
          onChat: text => {
            if (dictationRef.current) {
              // 听写模式下识别句只进输入框；小赫不回答，也不累积回复文本。
              return
            }

            if (text) {
              const current = replyTextRef.current

              if (!current) {
                replyTextRef.current = text
              } else if (text.startsWith(current)) {
                replyTextRef.current = text
              } else if (!current.startsWith(text)) {
                replyTextRef.current = current + text
              }

              setReplyText(replyTextRef.current)
            }

            if (text && metricsTurnOpenRef.current && !metricsFirstTextRef.current) {
              metricsFirstTextRef.current = true
              emit(VOICE_EVENT.FIRST_TEXT_DELTA, { chars: text.length, source: 'realtime' })
            }
          },
          onFirstAudio: () => {
            if (metricsTurnOpenRef.current) {
              emit(VOICE_EVENT.TTS_FIRST_AUDIO, { source: 'realtime' })
              emit(VOICE_EVENT.PLAYBACK_START, { source: 'realtime' })
            }

            localBargeFiredRef.current = false
            localVadRef.current?.reset()
            setStatus('speaking')
          },
          onEnd: () => {
            localBargeFiredRef.current = false
            localVadRef.current?.reset()
            commandHandledRef.current = null
            turnResumeHandledRef.current = false
            setTranscript('')
            closeRealtimeMetricsTurn()
            setStatus('listening')
          },
          onError: error => {
            console.error('[realtime-voice] dialogue error', error)
            emit(VOICE_EVENT.ERROR, { code: 'dialogue_error', source: 'realtime' })
            localBargeFiredRef.current = false
            localVadRef.current?.reset()
            commandHandledRef.current = null
            turnResumeHandledRef.current = false
            setTranscript('')
            closeRealtimeMetricsTurn()
            notifyError(error, 'Realtime dialogue failed')
            sessionRef.current = null
            cleanupCapture()
            setStatus('idle')
          }
        })

        if (!session) {
          console.error('[realtime-voice] dialogue unavailable')
          throw new Error('Realtime dialogue is unavailable')
        }

        sessionRef.current = session
      }

      // Wake handoff: 豆包 voices the acknowledgement inside this same turn, so it
      // arrives as realtime dialogue audio instead of a locally-rendered clip.
      const greeting = takeWakeGreeting()
        ? WAKE_ACKS[Math.floor(Math.random() * WAKE_ACKS.length)]!
        : undefined

      openRealtimeMetricsTurn(true)
      session.beginTurn(greeting)
      const lease = await acquireCapture({ ownerId: 'live-conversation' })
      leaseRef.current = lease
      captureStopRef.current = startPcmCapture({
        stream: lease.stream,
        onChunk: chunk => {
          sessionRef.current?.sendPcm(chunk)
          const level = pcmRms(chunk)

          if (localBargeFiredRef.current || statusRef.current !== 'speaking') {
            localVadRef.current?.reset()

            return
          }

          if (localVadRef.current?.process(level)) {
            localBargeFiredRef.current = true
            stopVoicePlayback()
            sessionRef.current?.interruptPlayback()
            emit(VOICE_EVENT.BARGE_TRIP, { source: 'realtime' })
            // interruptPlayback() fades active clips to zero over ~150ms;
            // stamp the effective silence point so voice-metrics can compute
            // barge_to_silence on the realtime path.
            window.setTimeout(
              () => emit(VOICE_EVENT.PLAYBACK_STOPPED, { source: 'realtime' }),
              180
            )
          }
        }
      })
      meterStopRef.current = startMeter(lease.stream)
    } catch (error) {
      console.error('[realtime-voice] start failed', error)
      emit(VOICE_EVENT.ERROR, { code: 'start_failed', source: 'realtime' })
      closeRealtimeMetricsTurn()
      cleanupCapture()
      sessionRef.current = null
      setStatus('idle')
      notifyError(error, 'Could not start realtime voice')
      onFatalError?.()
    }
  }, [cleanupCapture, closeRealtimeMetricsTurn, onFatalError, openRealtimeMetricsTurn, startMeter])

  // eslint-disable-next-line no-restricted-syntax -- mirror ref assignment pattern above
  useEffect(() => {
    startListeningRef.current = startListening
  }, [startListening])

  const start = useCallback(async () => {
    stoppingRef.current = false
    setMuted(false)
    await startListening()
  }, [startListening])

  const end = useCallback(async () => {
    stoppingRef.current = true
    localBargeFiredRef.current = false
    localVadRef.current?.reset()
    dictationRef.current = false
    dictationPausedRef.current = false
    stopVoicePlayback()
    setTranscript('')
    closeRealtimeMetricsTurn()
    sessionRef.current?.stop()
    cleanupCapture()
    sessionRef.current = null
    setMuted(false)
    setStatus('idle')
  }, [cleanupCapture, closeRealtimeMetricsTurn])

  // eslint-disable-next-line no-restricted-syntax -- pre-existing enable/disable effect
  useEffect(() => {
    if (enabled && !wasEnabledRef.current) {
      void start()
    }

    if (!enabled && wasEnabledRef.current) {
      void end()
    }

    wasEnabledRef.current = enabled
  }, [enabled, end, start])

  const stopTurn = useCallback(() => {
    // Full-duplex: the server owns turn-taking, so there is no local
    // end-of-turn control. This remains for API compatibility.
    return undefined
  }, [])

  const toggleMute = useCallback(() => {
    setMuted(value => {
      const next = !value

      if (next) {
        closeRealtimeMetricsTurn()
        sessionRef.current?.stop()
        cleanupCapture()
        setStatus('idle')
      } else if (enabledRef.current && !stoppingRef.current && statusRef.current === 'idle') {
        void startListening()
      }

      return next
    })
  }, [cleanupCapture, closeRealtimeMetricsTurn, startListening])

  return { end, level, muted, replyText, start, status, stopTurn, toggleMute, transcript }
}
