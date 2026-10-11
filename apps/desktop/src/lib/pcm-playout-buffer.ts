// PCM playout buffer — Task 5 (plan v2 §6)
//
// 纯函数/类 PCM frame 调度器。**不直接操作 AudioContext**——只管理 frame 队列 + 时间排程。
// voice-playback.ts 把每条从 ws 收到的 binary frame 喂进 buffer；buffer 输出
// "在 audioContext.currentTime 之后 X 秒开始播放这个 PCM buffer" 的指令。
//
// 设计：
// 1. 纯数据处理：odd-byte carry、sample 转换、frame 合并
// 2. 取消保护：cancelled 标志位一旦 set，新 frame 静默丢弃，已 schedule 的 audio 不动（AudioContext close 切断）
// 3. startup buffer：schedule 第一帧时增加 startupBufferMs 延迟（80-150ms 起步缓冲，吸收 jitter）
// 4. sample rate 变化：接 start frame 携带的 sample_rate 字段，重建 Int16Array stride
// 5. 全部 callback 同步 / async-safe

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface PcmFrame {
  /** 原始 binary 帧（int16 LE PCM，单声道） */
  data: ArrayBuffer
  /** server 报告的 sample rate（Hz）。仅在 sample-rate control frame 里给。 */
  sampleRate?: number
  /** server frame index（用于诊断 / 重复检测） */
  index?: number
}

export interface ScheduledClip {
  /** AudioBufferSourceNode.start(at) 用 */
  startAt: number
  /** 已转换的 Float32 PCM（-1..1），可直接给 AudioBuffer */
  pcm: Float32Array
  /** 这个 clip 的 sample rate */
  sampleRate: number
}

export interface ScheduleOptions {
  /** 起步缓冲：第一个 clip 延迟 X 毫秒开始（默认 100ms） */
  startupBufferMs?: number
  /** AudioContext.currentTime 的引用（避免 buffer 直接 import AudioContext） */
  currentTime: () => number
  /**
   * 控制 frame callback：server 可能发 sample_rate 更新等控制消息
   * 走这里而不走 ingest()
   */
  onSampleRateChange?: (rate: number) => void
}

// Adaptive jitter buffer tuning. The playout keeps a small head start so a
// slightly late chunk cannot underrun audio; when chunks arrive late it raises
// the head start, and after a stable run it lowers it back toward the minimum.
const ADAPTIVE_MIN_MS = 20
const ADAPTIVE_MAX_MS = 50
const ADAPTIVE_STEP_MS = 5
const ADAPTIVE_SMOOTH_FRAMES = 8
const ADAPTIVE_LATE_MS = 20
const ADAPTIVE_MAX_LATE_MS = 250

// ---------------------------------------------------------------------------
// PcmPlayoutBuffer
// ---------------------------------------------------------------------------

export class PcmPlayoutBuffer {
  /** int16 → float 转换缓存（避免每帧重建） */
  private carry: Uint8Array | null = null
  /** 当前帧的 sample rate（default 24kHz 直到 start frame 覆盖） */
  private streamRate: number
  /** 下一个 clip 应该 start 的时间（AudioContext.currentTime 域） */
  private nextStartAt: number
  /** 是否已启动（first audio 已发出） */
  private started: boolean = false
  /** 取消标志 */
  private cancelled: boolean = false
  /** currentTime 引用 */
  private readonly currentTime: () => number
  /** startup buffer 毫秒 */
  private readonly startupBufferMs: number
  /** adaptive head start, in ms, clamped between ADAPTIVE_MIN_MS/MAX_MS */
  private adaptiveBufferMs: number
  private readonly minAdaptiveMs: number
  private readonly maxAdaptiveMs: number
  /** AudioContext.currentTime at the previous scheduled frame */
  private lastIngestAt = 0
  /** duration (seconds) of the previous scheduled frame */
  private lastFrameDurationSec = 0
  /** consecutive non-late frames since the last adjustment */
  private smoothFrames = 0
  /** sample rate 变化 callback */
  private readonly onSampleRateChange: (rate: number) => void

  constructor(options: ScheduleOptions) {
    this.streamRate = 24_000
    this.nextStartAt = 0
    this.currentTime = options.currentTime
    this.startupBufferMs = options.startupBufferMs ?? 100
    this.adaptiveBufferMs = this.startupBufferMs
    this.minAdaptiveMs = Math.min(ADAPTIVE_MIN_MS, this.startupBufferMs)
    this.maxAdaptiveMs = Math.max(ADAPTIVE_MAX_MS, this.startupBufferMs)
    this.onSampleRateChange = options.onSampleRateChange ?? (() => undefined)
  }

  /**
   * 处理一条 PCM frame，返回应 schedule 的 clip（或 null if discarded）。
   * **不直接操作 AudioContext**——调用方拿到 clip 后自己 source.start()。
   */
  ingest(frame: PcmFrame): ScheduledClip | null {
    if (this.cancelled) {
      return null
    }

    // Sample rate 变化
    if (typeof frame.sampleRate === 'number' && frame.sampleRate > 0) {
      if (this.streamRate !== frame.sampleRate) {
        this.streamRate = frame.sampleRate
        this.onSampleRateChange(frame.sampleRate)
      }
    }

    // 1) odd-byte carry
    let bytes = new Uint8Array(frame.data)

    if (this.carry) {
      const joined = new Uint8Array(this.carry.length + bytes.length)
      joined.set(this.carry)
      joined.set(bytes, this.carry.length)
      bytes = joined
      this.carry = null
    }

    // 2) sample alignment
    const usable = bytes.length - (bytes.length % 2)

    if (bytes.length !== usable) {
      this.carry = bytes.slice(usable)
    }

    if (!usable) {
      return null
    }

    // 3) int16 LE → Float32
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, usable / 2)
    const float32 = new Float32Array(pcm.length)

    for (let i = 0; i < pcm.length; i += 1) {
      float32[i] = pcm[i]! / 32_768
    }

    // 4) compute startAt
    const now = this.currentTime()

    if (!this.started) {
      // 起步缓冲：吸收 jitter
      this.nextStartAt = Math.max(
        now + this.adaptiveBufferMs / 1_000,
        now + Math.min(0.05, this.adaptiveBufferMs / 1_000)
      )
      this.started = true
    } else {
      const expectedGap = this.lastFrameDurationSec
      const gap = Math.max(0, now - this.lastIngestAt)
      const lateBy = expectedGap > 0 ? gap - expectedGap : 0

      if (lateBy > ADAPTIVE_LATE_MS / 1_000 && lateBy <= ADAPTIVE_MAX_LATE_MS / 1_000) {
        this.smoothFrames = 0
        this.adaptiveBufferMs = Math.min(this.maxAdaptiveMs, this.adaptiveBufferMs + ADAPTIVE_STEP_MS)
      } else {
        this.smoothFrames += 1

        if (this.smoothFrames >= ADAPTIVE_SMOOTH_FRAMES) {
          this.smoothFrames = 0
          this.adaptiveBufferMs = Math.max(this.minAdaptiveMs, this.adaptiveBufferMs - ADAPTIVE_STEP_MS)
        }
      }

      this.nextStartAt = Math.max(now + Math.min(0.05, this.adaptiveBufferMs / 1_000), this.nextStartAt)
    }

    const clip: ScheduledClip = {
      startAt: this.nextStartAt,
      pcm: float32,
      sampleRate: this.streamRate
    }

    // 5) update nextStartAt for next clip (continuous排程)
    const durationSec = float32.length / this.streamRate
    this.nextStartAt += durationSec
    this.lastIngestAt = now
    this.lastFrameDurationSec = durationSec

    return clip
  }

  /** 取消：之后所有 ingest() 返回 null。 */
  cancel(): void {
    this.cancelled = true
    this.carry = null
  }

  isCancelled(): boolean {
    return this.cancelled
  }

  getCurrentSampleRate(): number {
    return this.streamRate
  }

  /** Current adaptive head start in ms (useful for diagnostics/tests). */
  getCurrentStartupBufferMs(): number {
    return this.adaptiveBufferMs
  }

  /** End time (seconds) of the last scheduled clip; 0 before the first frame. */
  getNextStartAt(): number {
    return this.nextStartAt
  }

  /** 测试用：重置整个 buffer。 */
  reset(): void {
    this.carry = null
    this.streamRate = 24_000
    this.nextStartAt = 0
    this.started = false
    this.cancelled = false
    this.adaptiveBufferMs = this.startupBufferMs
    this.lastIngestAt = 0
    this.lastFrameDurationSec = 0
    this.smoothFrames = 0
  }
}

// ---------------------------------------------------------------------------
// 纯函数 helpers（testable in isolation）
// ---------------------------------------------------------------------------

/**
 * 把 int16 LE 字节转 Float32 PCM。**不**做 carry / sample alignment（那是 ingest 职责）。
 * 暴露这个函数让 unit test 单独测。
 */
export function int16LeToFloat32(buffer: ArrayBuffer): Float32Array {
  const pcm = new Int16Array(buffer)
  const out = new Float32Array(pcm.length)

  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = pcm[i]! / 32_768
  }

  return out
}

/**
 * 按句号、问号、感叹号、问号+感叹号组合、句点+引号等切分中英文句子。
 * 保留原始标点 + trim 前导空格。
 */
export function splitSentencesForStreaming(text: string): string[] {
  if (!text) {return []}
  const sentences: string[] = []
  // Match sentence terminators (English + Chinese full-width + CJK close quotes)
  // sentence = 文字 + terminator，terminator = [.!?。！？] + 可选 closing quote
  const re = /[^.!?。！？]+[.!?。！？]+["'”’）)]*/g
  let lastEnd = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    const piece = m[0].trim()

    if (piece) {
      sentences.push(piece)
    }

    lastEnd = m.index + m[0].length
  }

  // Trailing fragment without terminator
  if (lastEnd < text.length) {
    const tail = text.slice(lastEnd).trim()

    if (tail) {
      sentences.push(tail)
    }
  }

  return sentences
}
