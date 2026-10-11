// Spoken stop-word detection for the voice conversation loop.
//
// When someone is in a hands-free "Hey Hermes" voice chat, the natural way to
// end it is to SAY "stop" — not reach for the mouse. Without this, a spoken
// "stop" is just transcribed and sent to the agent as a normal turn, so the
// conversation never ends (the reported bug). This matcher recognises a short
// utterance whose entire content is a stop command and ends the conversation
// instead of submitting it.
//
// Deliberately conservative: it only fires when the WHOLE utterance is a stop
// phrase (optionally addressed to Hermes), so a real turn that merely contains
// the word "stop" — e.g. "stop the docker container" or "how do I stop a
// running process" — is never swallowed.
//
// Config: a customised `voice.stop_phrases` replaces the built-in English list
// (any language). Absent or left at the backend default, the English list below
// is used. An explicit empty list disables spoken stop entirely — mirroring
// `tools.voice_mode.is_voice_stop_phrase` (#117801).

import { $voiceStopPhraseConfig, type VoiceStopPhraseConfig } from '@/store/voice-prefs'

// Canonical English stop commands used while `voice.stop_phrases` is unset or
// still the backend default (see `applyVoiceStopPhraseFromConfig`).
const STOP_PHRASES: readonly string[] = [
  'stop',
  'stop listening',
  'stop it',
  'stop please',
  'please stop',
  'stop stop',
  'that is all',
  "that's all",
  'never mind',
  'nevermind',
  'end conversation',
  'end the conversation',
  'goodbye',
  'good bye',
  'bye',
  'cancel',
  '结束',
  '结束吧',
  '结束对话',
  '结束语音',
  '结束语音对话',
  '退出',
  '退出对话',
  '退出语音',
  '退出语音对话',
  '停止',
  '停止对话',
  '停止语音',
  '停止语音对话',
  '再见',
  '不说了',
  '先这样',
  '关闭语音',
  '关闭语音对话'
]

// Canonical pause commands. Unlike stop commands, a pause only interrupts the
// current spoken reply; the conversation stays open.
const PAUSE_PHRASES: readonly string[] = [
  '停',
  '停下',
  '停下吧',
  '停一下',
  '先停一下',
  '暂停',
  '暂停一下',
  '别说了',
  '别读了',
  '别念了',
  '不读了',
  '不要再说了'
]

// Canonical resume commands - pick up the interrupted reply from where it
// stopped, without starting a new agent turn.
const RESUME_PHRASES: readonly string[] = [
  '继续',
  '继续读',
  '继续朗读',
  '继续念',
  '继续吧',
  '继续读吧',
  '继续朗读吧',
  '继续念吧',
  '接着读',
  '接着念',
  '接着读吧',
  '接着念吧',
  'go on',
  'continue',
  'keep going',
  'go ahead'
]

// Canonical dictation-mode commands - spoken while the hands-free voice
// conversation is live, they switch the loop from "submit a turn" to
// "append the transcript to the composer draft without sending".
const DICTATION_PHRASES: readonly string[] = [
  '听写',
  '开始听写',
  '语音听写',
  '开始语音听写',
  '听写模式'
]

// Optional address prefixes so "hermes stop" / "ok stop" / "hey hermes, stop"
// still count. Stripped before matching the core phrase.
const ADDRESS_PREFIXES: readonly string[] = [
  'hey hermes',
  'hey hermes,',
  'hermes',
  'hermes,',
  'ok',
  'okay',
  'hey',
  'hey xiaohe',
  'hey xiaohe,',
  '嘿小赫',
  '嘿小赫，',
  '小赫',
  '小赫，'
]

// Normalise: Unicode-compose (so an NFD "отбой" from STT equals the NFC phrase
// in config.yaml), lowercase, turn punctuation from ANY script into spaces
// ("стоп!", "«отбой»", "停止。"), collapse whitespace. Transcripts and
// configured phrases go through the same function, so the match stays exact —
// like the backend's `is_voice_stop_phrase` — just punctuation-insensitive.
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{P}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Doubao ASR often hears the bot name as a homophone ("xiaohe / xiaohe / ...").
// Normalise before display and before command matching so the bot name is
// stable and address-prefixed stop/pause phrases still match.
const BOT_NAME_ALIASES: Record<string, string> = {
  '小贺': '小赫',
  '小荷': '小赫',
  '小和': '小赫',
  '小何': '小赫',
  '晓赫': '小赫',
  '晓贺': '小赫',
  '晓荷': '小赫',
  '晓和': '小赫',
  '晓何': '小赫'
}

export function normalizeBotName(text: string): string {
  if (!text) {
    return text
  }

  let normalized = text

  for (const [alias, canonical] of Object.entries(BOT_NAME_ALIASES)) {
    normalized = normalized.split(alias).join(canonical)
  }

  return normalized
}

function stripAddress(text: string): string {
  for (const prefix of ADDRESS_PREFIXES) {
    if (text === prefix) {
      // Bare address ("hermes") is not a stop command on its own.
      continue
    }

    if (text.startsWith(`${prefix} `)) {
      return text.slice(prefix.length + 1).trim()
    }

    if (/[^\x00-\x7F]/.test(prefix) && text.startsWith(prefix)) {
      return text.slice(prefix.length).trim()
    }
  }

  return text
}

const DEFAULT_PHRASES = STOP_PHRASES.map(normalize)

function phrasesForConfig(config: VoiceStopPhraseConfig): readonly string[] | null {
  if (config.mode === 'disabled') {
    return null
  }

  if (config.mode === 'custom') {
    return config.phrases.map(normalize).filter(phrase => phrase.length > 0)
  }

  return DEFAULT_PHRASES
}

/**
 * True when the entire spoken utterance is a stop command (optionally addressed
 * to Hermes). Returns false for anything that merely contains "stop" as part of
 * a longer, substantive request.
 *
 * Pass `config` in tests; production reads `$voiceStopPhraseConfig`.
 */
export function isVoiceStopCommand(
  transcript: string,
  config: VoiceStopPhraseConfig = $voiceStopPhraseConfig.get()
): boolean {
  if (!transcript) {
    return false
  }

  const phrases = phrasesForConfig(config)

  if (phrases == null || phrases.length === 0) {
    return false
  }

  const normalized = normalize(normalizeBotName(transcript))

  if (!normalized) {
    return false
  }

  // Match with the address prefix stripped, and also as-is (so a bare "stop"
  // with no prefix still matches, and "please stop" — where "please" isn't a
  // prefix — matches directly).
  const candidates = new Set([normalized, stripAddress(normalized)])

  for (const candidate of candidates) {
    if (phrases.includes(candidate)) {
      return true
    }
  }

  return false
}

/**
 * True when the entire spoken utterance is a pause command (interrupt the
 * current reply, keep the conversation open).
 */
export function isVoicePauseCommand(transcript: string): boolean {
  if (!transcript) {
    return false
  }

  const normalized = normalize(normalizeBotName(transcript))

  if (!normalized) {
    return false
  }

  const candidates = new Set([normalized, stripAddress(normalized)])

  for (const candidate of candidates) {
    if (PAUSE_PHRASES.includes(candidate)) {
      return true
    }
  }

  return false
}

/**
 * True when the entire spoken utterance asks to resume the interrupted reply
 * (e.g. resume / keep reading).
 */
export function isVoiceResumeCommand(transcript: string): boolean {
  if (!transcript) {
    return false
  }

  const normalized = normalize(normalizeBotName(transcript))

  if (!normalized) {
    return false
  }

  const candidates = new Set([normalized, stripAddress(normalized)])

  for (const candidate of candidates) {
    if (RESUME_PHRASES.includes(candidate)) {
      return true
    }
  }

  return false
}

/**
 * True when the entire spoken utterance asks to enter dictation mode
 * (transcript -> composer draft, no agent turn / no spoken reply).
 */
export function isVoiceDictationCommand(transcript: string): boolean {
  if (!transcript) {
    return false
  }

  const normalized = normalize(normalizeBotName(transcript))

  if (!normalized) {
    return false
  }

  const candidates = new Set([normalized, stripAddress(normalized)])

  for (const candidate of candidates) {
    if (DICTATION_PHRASES.includes(candidate)) {
      return true
    }
  }

  return false
}

/**
 * Typed-stop interception decision for the composer: a bare stop command
 * typed while the voice conversation is live ends the conversation instead of
 * being sent as a turn. Attachments mean the message is a real payload —
 * never intercepted. Outside a voice conversation typed text always passes
 * through unchanged.
 */
export function interceptsTypedVoiceStop(conversationActive: boolean, text: string, attachmentCount = 0): boolean {
  return conversationActive && attachmentCount === 0 && isVoiceStopCommand(text)
}
