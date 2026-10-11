// Voice metrics — 轻量埋点模块（Task 2）
// 9 个事件点对应 plan §7.1 / §7.2 全部延迟 gap：
//   mic_open, speech_start, speech_end, stt_final,
//   turn_submit, first_text_delta, tts_first_audio, playback_start,
//   barge_trip, turn_end, error
//
// 设计原则：
// 1. 纯埋点：emit 只调 setTimeout(0) 把事件扔到 ring buffer，主流程不阻塞
// 2. 可关闭：voice.metrics.enabled = false 时 emit 是 no-op
// 3. 本地落盘：每个 turn 结束时 flush 到 ~/.hermes/logs/voice-metrics.jsonl
// 4. 不入 React state：不引发 re-render（debug overlay 用单独订阅机制）
// 5. 不破坏 prompt caching：emit 是 sync 写 ref + 异步 flush

// 事件名常量
export const VOICE_EVENT = {
  MIC_OPEN: 'mic_open',
  SPEECH_START: 'speech_start',
  SPEECH_END: 'speech_end',
  STT_FINAL: 'stt_final',
  TURN_SUBMIT: 'turn_submit',
  FIRST_TEXT_DELTA: 'first_text_delta',
  TTS_FIRST_AUDIO: 'tts_first_audio',
  PLAYBACK_START: 'playback_start',
  PLAYBACK_STOPPED: 'playback_stopped',
  BARGE_TRIP: 'barge_trip',
  BARGE_MONITOR_ARMED: 'barge_monitor_armed',
  TURN_END: 'turn_end',
  ERROR: 'error'
} as const

export type VoiceEventName = typeof VOICE_EVENT[keyof typeof VOICE_EVENT]

interface VoiceEvent {
  name: VoiceEventName
  t: number          // ms since turn start
  wallTs: number     // unix ms
  turnId: string
  meta?: Record<string, unknown>
}

interface TurnRecord {
  turnId: string
  startedAt: number  // wall ts
  events: VoiceEvent[]
  gaps: Record<string, number | null>
}

/** 状态：单 turn 内累积 */
let currentTurn: TurnRecord | null = null
let turnT0 = 0
// enabled / debugOverlayEnabled live on globalThis (not module `let`) so the
// bundler cannot constant-fold them: rolldown saw `let enabled = false` +
// `if (!enabled) return` and proved the rest of emit() unreachable, then
// tree-shook the entire body + every call site (observed 2026-08-09).
const _voiceMetricsState = globalThis as Record<string, unknown>
let enabled = Boolean(_voiceMetricsState['__voiceMetricsEnabled'])
let debugOverlayEnabled = Boolean(_voiceMetricsState['__voiceMetricsDebugOverlay'])
const debugListeners = new Set<(turn: TurnRecord) => void>()

/**
 * 从 desktop voice-prefs store 读 metrics config。
 * use-hermes-config 在 config 加载完成后会调 applyVoiceMetricsConfig()；
 * 这里用一个 setter 桥接，让 voice-metrics 模块不直接 import store。
 */
export function applyVoiceMetricsConfig(cfg: { enabled?: unknown; debug_overlay?: unknown } | null | undefined): void {
  enabled = Boolean(cfg?.enabled)
  debugOverlayEnabled = Boolean(cfg?.debug_overlay)
  _voiceMetricsState['__voiceMetricsEnabled'] = enabled
  _voiceMetricsState['__voiceMetricsDebugOverlay'] = debugOverlayEnabled
}

/** 注册 debug overlay 监听器（voice dock 用）。返回 disposer。 */
export function onVoiceMetricsUpdate(fn: (turn: TurnRecord) => void): () => void {
  debugListeners.add(fn)
  return () => debugListeners.delete(fn)
}

export function isVoiceMetricsEnabled(): boolean {
  return Boolean(_voiceMetricsState['__voiceMetricsEnabled'])
}

export function isVoiceMetricsDebugOverlayEnabled(): boolean {
  return debugOverlayEnabled
}

export function startTurn(turnId: string): void {
  if (!Boolean(_voiceMetricsState['__voiceMetricsEnabled'])) return
  // 上一 turn 还没关？强制 flush
  if (currentTurn && currentTurn.turnId !== turnId) {
    void flushTurn()
  }
  currentTurn = {
    turnId,
    startedAt: Date.now(),
    events: [],
    gaps: {}
  }
  turnT0 = performance.now()
}

/** emit 一个事件。sync 写 ref + 异步通知 debug listeners，**不入 React state**。 */
export function emit(name: VoiceEventName, meta?: Record<string, unknown>): void {
  // Read the gate through globalThis (see the state comment above): the
  // bundler can't constant-fold globalThis reads, so the early-return branch
  // stays reachable and the event-push body survives tree-shaking.
  const gateEnabled = Boolean(_voiceMetricsState['__voiceMetricsEnabled'])
  const gateDebug = Boolean(_voiceMetricsState['__voiceMetricsDebugOverlay'])
  if (!gateEnabled && !gateDebug) return
  const now = performance.now()
  const wall = Date.now()
  const event: VoiceEvent = {
    name,
    t: now - turnT0,
    wallTs: wall,
    turnId: currentTurn?.turnId ?? 'orphan',
    meta
  }
  if (gateEnabled && currentTurn) {
    currentTurn.events.push(event)
  }
  if (gateDebug && currentTurn) {
    // 异步通知，不阻塞
    setTimeout(() => {
      debugListeners.forEach(fn => {
        try { fn(currentTurn!) } catch { /* ignore */ }
      })
    }, 0)
  }
}

/** 标记 turn 结束，flush 到磁盘。 */
export function endTurn(): void {
  if (!Boolean(_voiceMetricsState['__voiceMetricsEnabled'])) {
    currentTurn = null
    return
  }
  if (!currentTurn) return
  emit(VOICE_EVENT.TURN_END)
  void flushTurn()
}

async function flushTurn(): Promise<void> {
  const turn = currentTurn
  if (!turn || turn.events.length === 0) {
    currentTurn = null
    return
  }
  // 计算 plan §7.1 / §7.2 用到的 9 个 gap
  turn.gaps = computeGaps(turn.events)
  currentTurn = null

  // 异步落盘：fire-and-forget，错误不抛
  setTimeout(() => {
    writeJsonl(turn).catch(() => undefined)
  }, 0)
}

function computeGaps(events: VoiceEvent[]): Record<string, number | null> {
  const find = (n: string) => events.find(e => e.name === n)?.t ?? null
  const gap = (a: string, b: string): number | null => {
    const ea = find(a)
    const eb = find(b)
    if (ea === null || eb === null) return null
    return Math.round(eb - ea)
  }
  return {
    'mic_to_listening': gap(VOICE_EVENT.MIC_OPEN, VOICE_EVENT.SPEECH_START),
    'speech_end_to_stt_final': gap(VOICE_EVENT.SPEECH_END, VOICE_EVENT.STT_FINAL),
    'stt_final_to_submit': gap(VOICE_EVENT.STT_FINAL, VOICE_EVENT.TURN_SUBMIT),
    'submit_to_first_delta': gap(VOICE_EVENT.TURN_SUBMIT, VOICE_EVENT.FIRST_TEXT_DELTA),
    'first_delta_to_first_audio': gap(VOICE_EVENT.FIRST_TEXT_DELTA, VOICE_EVENT.TTS_FIRST_AUDIO),
    'first_audio_to_playback_start': gap(VOICE_EVENT.TTS_FIRST_AUDIO, VOICE_EVENT.PLAYBACK_START),
    'submit_to_first_audio': gap(VOICE_EVENT.TURN_SUBMIT, VOICE_EVENT.TTS_FIRST_AUDIO),
    'barge_to_silence': gap(VOICE_EVENT.BARGE_TRIP, VOICE_EVENT.PLAYBACK_STOPPED),
    'turn_total_ms': find(VOICE_EVENT.TURN_END) ?? null
  }
}

/**
 * 解析 Hermes home 目录。
 *
 * 优先用 Electron 主进程 bridge 暴露的 `window.hermesDesktop.hermesHome`
 * （main.ts 注入 HERMES_HOME）；fallback 到 `process.env.HERMES_HOME`；
 * 都没有则返回 null（调用方跳过落盘，不阻塞语音主流程）。
 *
 * 注意：renderer 端不能直接 import 'node:fs/promises'（浏览器环境没 fs，
 * vite build 会 externalize，运行时炸）。落盘由 main 进程通过
 * `hermes:voice-metrics:append` IPC 完成。
 */
function resolveHermesHome(): string | null {
  const desktop = (globalThis as { hermesDesktop?: { hermesHome?: unknown } }).hermesDesktop
  const viaBridge = desktop?.hermesHome
  if (typeof viaBridge === 'string' && viaBridge) {
    return viaBridge
  }
  const viaEnv = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.HERMES_HOME
  if (typeof viaEnv === 'string' && viaEnv) {
    return viaEnv
  }
  return null
}

async function writeJsonl(turn: TurnRecord): Promise<void> {
  const home = resolveHermesHome()
  const payload = {
    ts: turn.startedAt,
    turnId: turn.turnId,
    n_events: turn.events.length,
    events: turn.events.map(e => ({ name: e.name, t: e.t, meta: e.meta })),
    gaps: turn.gaps
  }
  try {
    // Fire-and-forget IPC: main process appends to voice-metrics.jsonl.
    // Renderer never touches node:fs (browser env has no fs). Sending the
    // raw object (not a pre-stringified line) lets main own the JSON
    // shape and works regardless of whether `hermesHome` is exposed to
    // the renderer (sandboxed preload can't import process.env).
    const desktop = (globalThis as { hermesDesktop?: { appendVoiceMetric?: (p: unknown) => Promise<unknown> } }).hermesDesktop
    if (!desktop?.appendVoiceMetric) {
      console.error('[voice-metrics] appendVoiceMetric bridge missing', { turnId: turn.turnId })
      return
    }
    await desktop.appendVoiceMetric(payload)
  } catch (error) {
    // metrics 错误不能影响语音主流程，但保留落盘失败现场
    console.error('[voice-metrics] append failed', { turnId: turn.turnId, error })
  }
}

/** 测试用：清空当前 turn 状态。 */
export function _resetForTests(): void {
  currentTurn = null
  turnT0 = 0
}

/** 测试用：读当前 turn（用于 vitest）。 */
export function _getCurrentTurn(): TurnRecord | null {
  return currentTurn
}
