// Realtime dialogue client for the desktop voice dock.
//
// Opens /api/audio/dialogue (half-duplex: push-to-talk PCM in, streamed
// assistant audio out), feeds raw int16 mono PCM captured from the mic, and
// plays the 24 kHz reply PCM through Web Audio as it arrives. The backend
// owns the ASR -> dialogue model -> TTS chain, so this surface never touches
// the segmented STT/LLM/TTS path.

import { resolveGatewayWsUrl } from '@hermes/shared'

import { getApiRequestProfile } from '@/hermes'
import { PcmPlayoutBuffer } from '@/lib/pcm-playout-buffer'
import { setAvatarMouthLevel } from '@/store/avatar'

export interface RealtimeDialogueCallbacks {
  sessionId?: string | null
  onAsr?: (text: string, final: boolean) => void
  onChat?: (text: string) => void
  onFirstAudio?: () => void
  onEnd?: () => void
  onError?: (error: Error) => void
}

export interface RealtimeDialogueSession {
  /** greet asks the service to voice that exact line as this turn's opener. */
  beginTurn: (greet?: string) => void
  sendPcm: (data: ArrayBuffer | ArrayBufferView) => void
  suppressReplyAudioUntilEnd: () => void
  resumeReplyAudio: () => void
  interruptPlayback: () => number
  end: () => void
  stop: () => void
  done: Promise<void>
}

async function resolveDialogueUrl(sessionId?: string | null): Promise<string | null> {
  const desktop = window.hermesDesktop

  if (!desktop?.getConnection) {
    console.error('[dialogue] missing desktop connection API')

    return null
  }

  try {
    const profile = getApiRequestProfile()
    const wsUrl = await resolveGatewayWsUrl(desktop, await desktop.getConnection(profile))
    const url = new URL(wsUrl)

    if (!url.pathname.endsWith('/api/ws')) {
      console.error('[dialogue] unexpected gateway ws path', url.pathname)

      return null
    }

    url.pathname = url.pathname.replace(/\/api\/ws$/, '/api/audio/dialogue')

    if (profile) {
      url.searchParams.set('profile', profile)
    }

    url.searchParams.set('mode', 'full_duplex')

    if (sessionId) {
      url.searchParams.set('session_id', sessionId)
    }

    return url.toString()
  } catch (error) {
    console.error('[dialogue] url resolve failed', error)

    return null
  }
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) {
    return data
  }

  if (data.byteLength === data.buffer.byteLength) {
    return data.buffer as ArrayBuffer
  }

  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

function openRealtimeDialogue(wsUrl: string, callbacks: RealtimeDialogueCallbacks): RealtimeDialogueSession {
  const ws = new WebSocket(wsUrl)
  ws.binaryType = 'arraybuffer'

  let context: AudioContext | null = null
  let outputRate = 24_000
  let started = false
  let settled = false
  let ended = false
  let stopped = false
  let interrupted = false
  let suppressReplyAudio = false
  let suppressTimer: ReturnType<typeof setTimeout> | null = null
  let turnStartedAt = 0
  let lastScheduledEndAt = 0
  const pendingSends: Array<ArrayBuffer | string> = []

  const playout = new PcmPlayoutBuffer({
    startupBufferMs: 30,
    currentTime: () => context?.currentTime ?? 0,
    onSampleRateChange: rate => {
      outputRate = rate
    }
  })

  const activeSources = new Set<{ source: AudioBufferSourceNode; gain: GainNode; startAt: number }>()
  // Output-bus energy: a master gain + analyser sit between every clip and the
  // speakers. A rAF reads the analyser and feeds the avatar the RMS of what is
  // actually audible RIGHT NOW — chunk timing, gaps and queueing can't matter,
  // so a long reply keeps its waveform for the whole duration.
  let masterGain: GainNode | null = null
  let outputAnalyser: AnalyserNode | null = null
  let energyData = new Uint8Array(0)
  let energyRaf = 0

  let settle: () => void = () => undefined

  const done = new Promise<void>(resolve => {
    settle = () => {
      if (settled) {
        return
      }

      settled = true

      if (energyRaf !== 0) {
        window.cancelAnimationFrame(energyRaf)
        energyRaf = 0
      }

      setAvatarMouthLevel(0)

      try {
        ws.close()
      } catch {
        // already closed
      }

      void context?.close().catch(() => undefined)
      context = null
      resolve()
    }
  })

  const sendJson = (frame: object) => {
    const data = JSON.stringify(frame)

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    } else if (ws.readyState === WebSocket.CONNECTING) {
      pendingSends.push(data)
    }
  }

  const ensureContext = () => {
    if (!context) {
      context = new AudioContext()
      masterGain = context.createGain()
      outputAnalyser = context.createAnalyser()
      outputAnalyser.fftSize = 256
      masterGain.connect(outputAnalyser)
      outputAnalyser.connect(context.destination)
      energyData = new Uint8Array(outputAnalyser.fftSize)

      if (energyRaf === 0) {
        const tick = () => {
          const analyser = outputAnalyser

          if (!analyser || !context) {
            energyRaf = 0

            return
          }

          analyser.getByteTimeDomainData(energyData)
          let sum = 0

          for (const value of energyData) {
            const centered = value - 128
            sum += centered * centered
          }

          setAvatarMouthLevel(Math.min(1, Math.sqrt(sum / energyData.length) / 42))
          energyRaf = window.requestAnimationFrame(tick)
        }

        tick()
      }
    }

    if (context.state === 'suspended') {
      void context.resume().catch(() => undefined)
    }
  }

  const finishWhenDrained = () => {
    // The server sends the `end` frame after the last TTS chunk; a short
    // drain window lets the final scheduled clip finish before the turn is
    // considered done. The WebSocket stays open for the next turn.
    const remainingMs = context ? Math.max(0, (playout.getNextStartAt() - context.currentTime) * 1_000) : 0
    window.setTimeout(() => {
      if (!stopped) {
        callbacks.onEnd?.()
      }
    }, remainingMs + 50)
  }

  const cutActivePlayback = () => {
    setAvatarMouthLevel(0)

    if (!context) {
      return
    }

    const now = context.currentTime
    const entries = Array.from(activeSources)
    const fadeUntil = now + 0.15

    for (const entry of entries) {
      // Future-buffered clips may not have started yet. Calling stop() before
      // start() throws, which would leave the buffered tail playing under the
      // pause confirmation. Stop each clip at its own start time instead.
      const stopAt = Math.max(fadeUntil, entry.startAt)

      try {
        entry.gain.gain.setValueAtTime(entry.gain.gain.value, now)
      } catch {
        // already closed
      }

      try {
        entry.gain.gain.linearRampToValueAtTime(0, stopAt)
      } catch {
        // already closed
      }

      try {
        entry.source.stop(stopAt)
      } catch {
        // already stopped
      }
    }

    window.setTimeout(() => {
      for (const entry of entries) {
        try {
          entry.source.disconnect()
        } catch {
          // already disconnected
        }

        try {
          entry.gain.disconnect()
        } catch {
          // already disconnected
        }

        activeSources.delete(entry)
      }
    }, 200)
  }

  const getPlayedSeconds = () => {
    if (!context || turnStartedAt === 0) {
      return 0
    }

    const scheduled = Math.max(0, lastScheduledEndAt - turnStartedAt)
    const played = Math.max(0, context.currentTime - turnStartedAt)

    return Math.min(played, scheduled)
  }

  const schedule = (data: ArrayBuffer) => {
    if (!context) {
      return
    }

    if (suppressReplyAudio) {
      return
    }

    const clip = playout.ingest({ data, sampleRate: outputRate })

    if (!clip) {
      return
    }

    const buffer = context.createBuffer(1, clip.pcm.length, clip.sampleRate)
    buffer.copyToChannel(new Float32Array(clip.pcm), 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    const gain = context.createGain()
    source.connect(gain)

    if (masterGain) {
      gain.connect(masterGain)
    } else {
      gain.connect(context.destination)
    }

    if (!started && activeSources.size > 0) {
      // A new reply's first chunk must never overlap the previous reply's
      // still-scheduled tail (the server does not send a fresh `start` frame
      // per turn, so this is the only reliable cut point).
      cutActivePlayback()
    }

    if (!started) {
      // The new reply is genuinely streaming now: clear the interrupt marker
      // so a later chat delta doesn't cut the audio we just started. The old
      // turn was already silenced by cutActivePlayback()/playout.reset().
      interrupted = false
      turnStartedAt = context.currentTime
    }

    source.start(clip.startAt)
    const entry = { source, gain, startAt: clip.startAt }
    activeSources.add(entry)
    source.onended = () => activeSources.delete(entry)
    lastScheduledEndAt = Math.max(lastScheduledEndAt, clip.startAt + buffer.duration)

    if (!started) {
      started = true
      callbacks.onFirstAudio?.()
    }
  }

  ws.onopen = () => {
    console.log('[dialogue] ws open')
    pendingSends.splice(0).forEach(data => ws.send(data))
  }

  ws.onmessage = event => {
    if (typeof event.data !== 'string') {
      schedule(event.data as ArrayBuffer)

      return
    }

    let frame: { channels?: number; message?: string; output_sample_rate?: number; text?: string; type?: string }

    try {
      frame = JSON.parse(event.data) as typeof frame
    } catch {
      return
    }

    if (frame.type === 'start') {
      outputRate = frame.output_sample_rate || 24_000
      cutActivePlayback()
      playout.reset()
      turnStartedAt = 0
      lastScheduledEndAt = 0
      interrupted = false

      if (suppressTimer !== null) {
        clearTimeout(suppressTimer)
        suppressTimer = null
      }

      suppressReplyAudio = false
      ensureContext()
    } else if (frame.type === 'asr') {
      callbacks.onAsr?.(frame.text ?? '', Boolean((frame as { final?: boolean }).final))
    } else if (frame.type === 'chat') {
      if (interrupted) {
        interrupted = false
        cutActivePlayback()
        playout.reset()
        started = false
        ended = false
      }

      callbacks.onChat?.(frame.text ?? '')
    } else if (frame.type === 'end') {
      setAvatarMouthLevel(0)

      // Compute the drain window BEFORE resetting the playout: reset() zeroes
      // nextStartAt, which would otherwise fire onEnd ~50ms after the end
      // frame while the final clips are still audible.
      finishWhenDrained()
      started = false
      ended = false
      interrupted = false
      playout.reset()
    } else if (frame.type === 'error') {
      // The server puts the reason in `message`; reading only `text` left the UI
      // showing the generic fallback for every backend failure.
      const detail = frame.text || frame.message || 'Realtime dialogue failed'

      console.error('[dialogue] server error frame', detail)
      callbacks.onError?.(new Error(detail))
      settle()
    }
  }

  ws.onerror = event => {
    console.error('[dialogue] ws error', event)
    callbacks.onError?.(new Error('Realtime dialogue WebSocket error'))
    settle()
  }

  ws.onclose = () => {
    if (!settled) {
      console.error('[dialogue] ws closed before reply settled')
      settle()
    }
  }

  return {
    beginTurn: (greet?: string) => {
      if (!settled) {
        ensureContext()
        playout.reset()
        started = false
        ended = false
        sendJson(greet ? { type: 'start', greet } : { type: 'start' })
      }
    },
    interruptPlayback: () => {
      const played = getPlayedSeconds()
      cutActivePlayback()
      interrupted = true
      // Reset instead of cancel: after a real follow-up, the server can stream
      // the new reply's first PCM frames before its first chat delta. A
      // cancelled playout would silently drop those frames and leave only the
      // tail audible. cutActivePlayback() already silences the old turn.
      playout.reset()
      started = false
      ended = false
      turnStartedAt = 0
      lastScheduledEndAt = 0

      return played
    },
    suppressReplyAudioUntilEnd: () => {
      if (suppressTimer !== null) {
        clearTimeout(suppressTimer)
      }

      suppressReplyAudio = true
      suppressTimer = setTimeout(() => {
        suppressReplyAudio = false
        suppressTimer = null
      }, 15000)
    },
    resumeReplyAudio: () => {
      if (suppressTimer !== null) {
        clearTimeout(suppressTimer)
        suppressTimer = null
      }

      suppressReplyAudio = false
    },
    sendPcm: data => {
      const bytes = toArrayBuffer(data)

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(bytes)
      } else if (ws.readyState === WebSocket.CONNECTING) {
        pendingSends.push(bytes)
      }
    },
    end: () => {
      if (!ended && !settled) {
        ended = true
        sendJson({ type: 'end' })
      }
    },
    stop: () => {
      stopped = true

      if (suppressTimer !== null) {
        clearTimeout(suppressTimer)
        suppressTimer = null
      }

      settle()
    },
    done
  }
}

export async function startRealtimeDialogue(
  callbacks: RealtimeDialogueCallbacks = {}
): Promise<RealtimeDialogueSession | null> {
  const wsUrl = await resolveDialogueUrl(callbacks.sessionId)

  if (!wsUrl) {
    return null
  }

  return openRealtimeDialogue(wsUrl, callbacks)
}
