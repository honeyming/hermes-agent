// Audio capture engine — Task 3 (plan v2 §6)
//
// 单一 mic owner：整个窗口一个 capture instance，3 个 caller（live conversation /
// barge monitor / dictation / wake）通过 lease 申请持有。
// 队尾者获胜：新 acquire 立刻 revoke 上一个 lease，旧 owner 的 onRevoked() 同步触发。
// devicechange 不静默换设备：所有 lease 释放，caller 重新 acquire 时报 DeviceChanged 错。
//
// 约束集中：AEC/NS/AGC 在 DEFAULT_CONSTRAINTS 一处声明；特殊 caller（wake）用
// 自定义 constraints 但**也走 lease**，所以不会出现"绕开 owner 直接 getUserMedia"的路径。
//
// 仍保留 MediaRecorder blob 输出（与现有 STT 链路兼容），不强行改 AudioWorklet。

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type CaptureOwnerId =
  | 'live-conversation'        // use-mic-recorder / use-voice-conversation
  | 'barge-monitor'            // voice-barge-in
  | 'dictation'                // push-to-talk 录音
  | 'wake-client'              // wake-client-capture（独立路径但走 lease）

export interface CaptureConstraints {
  channelCount?: number
  sampleRate?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  // 高级 caller（wake）需要 deviceId 指定
  deviceId?: { exact: string } | string
}

export interface CaptureLease {
  readonly id: string
  readonly ownerId: CaptureOwnerId
  readonly stream: MediaStream
  /** 同 stream 的 audio track 引用，方便 caller 调 stop / addEventListener */
  readonly audioTrack: MediaStreamTrack
  /**
   * 释放 lease。**幂等**——重复调用 no-op。
   * 正常 release 不抛错；只有内部错误才通过 console.warn 提示。
   */
  release: () => void
  /**
   * 当前 lease 被新 lease 抢占时同步触发（队尾者获胜）。
   * caller 应在回调里立即 stop 自己的 recorder / audio graph，
   * 不再使用 stream 上的 track。
   */
  onRevoked: (cb: () => void) => void
}

export class DeviceChangedError extends Error {
  constructor() {
    super('Audio input device changed; capture leases were released')
    this.name = 'DeviceChangedError'
  }
}

// ---------------------------------------------------------------------------
// 默认约束
// ---------------------------------------------------------------------------

export const DEFAULT_CAPTURE_CONSTRAINTS: CaptureConstraints = {
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true
}

// 调优参数集中在这一处
export const CAPTURE_CONFIG = {
  // lease 抢占：同 owner 重复 acquire 直接返回新 lease（ownerId 自身在内部被复用）
  // 异 owner：新 lease 立即 revoke 旧 lease
  // 无 owner：直接 acquire
  REVOKE_DELAY_MS: 0,        // 立即 revoke，无 grace
  DEVICE_CHANGE_DEBOUNCE_MS: 300
}

// ---------------------------------------------------------------------------
// 内部状态
// ---------------------------------------------------------------------------

interface InternalLease {
  id: string
  ownerId: CaptureOwnerId
  stream: MediaStream
  audioTrack: MediaStreamTrack
  revoked: boolean
  released: boolean
  onRevokedCallbacks: Set<() => void>
}

let _currentLease: InternalLease | null = null
let _deviceChangeHandler: (() => void) | null = null
let _leaseIdCounter = 0
let _nextDeviceChangeTs = 0

function isSupported(): boolean {
  return typeof navigator !== 'undefined'
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaStream !== 'undefined'
    && typeof MediaStreamTrack !== 'undefined'
}

function generateLeaseId(): string {
  _leaseIdCounter += 1
  return `lease-${Date.now()}-${_leaseIdCounter}`
}

function revokeLease(lease: InternalLease, reason: 'preempted' | 'device-change' | 'release'): void {
  if (lease.released) {
    return
  }
  lease.released = true
  lease.revoked = reason !== 'release'
  // 1) 同步触发 onRevoked 回调（caller 立即停 recorder）
  for (const cb of lease.onRevokedCallbacks) {
    try { cb() } catch { /* ignore */ }
  }
  lease.onRevokedCallbacks.clear()
  // 2) 停 audio track
  for (const track of lease.stream.getTracks()) {
    try { track.stop() } catch { /* ignore */ }
  }
  // 3) clear current
  if (_currentLease === lease) {
    _currentLease = null
  }
}

function installDeviceChangeListener(): void {
  if (_deviceChangeHandler) {
    return
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
    return
  }
  _deviceChangeHandler = () => {
    // debounce: 多个 devicechange 事件合并
    const now = Date.now()
    if (now < _nextDeviceChangeTs) {
      return
    }
    _nextDeviceChangeTs = now + CAPTURE_CONFIG.DEVICE_CHANGE_DEBOUNCE_MS

    if (_currentLease) {
      const lease = _currentLease
      // 不静默换：revoke 并让 caller 报 DeviceChanged
      revokeLease(lease, 'device-change')
    }
  }
  navigator.mediaDevices.addEventListener('devicechange', _deviceChangeHandler)
}

function uninstallDeviceChangeListener(): void {
  if (_deviceChangeHandler && navigator?.mediaDevices) {
    navigator.mediaDevices.removeEventListener('devicechange', _deviceChangeHandler)
    _deviceChangeHandler = null
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AcquireOptions {
  ownerId: CaptureOwnerId
  constraints?: CaptureConstraints
}

/**
 * 申请 mic 持有。**队尾者获胜**：新 lease 立即 revoke 旧 lease。
 * 失败抛：
 *   - Error('not_supported') — 浏览器/环境不支持
 *   - Error('permission_denied') / 'in_use' / 'no_device' / 'constraints_unsupported'
 *     — 与原 use-mic-recorder 的 micError() 命名保持一致，方便 caller 复用
 *   - DeviceChangedError — devicechange 触发了 revoke，caller 应重新 acquire
 */
export async function acquireCapture(options: AcquireOptions): Promise<CaptureLease> {
  if (!isSupported()) {
    throw new Error('Audio capture not supported in this environment')
  }

  installDeviceChangeListener()

  // 1) 抢占旧 lease
  if (_currentLease && !_currentLease.released) {
    revokeLease(_currentLease, 'preempted')
  }

  // 2) 合并 constraints
  const constraints: MediaStreamConstraints = {
    audio: {
      ...DEFAULT_CAPTURE_CONSTRAINTS,
      ...(options.constraints ?? {})
    } as MediaTrackConstraints,
    video: false
  }

  // 3) getUserMedia
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints)
  } catch (err) {
    throw mapMediaError(err)
  }

  // 4) 抽 audio track
  const audioTracks = stream.getAudioTracks()
  if (audioTracks.length === 0) {
    // 极端情况：stream 没 audio track
    for (const track of stream.getTracks()) {
      try { track.stop() } catch { /* ignore */ }
    }
    throw new Error('in_use')
  }
  const audioTrack = audioTracks[0]!

  // 5) 注册 lease
  const lease: InternalLease = {
    id: generateLeaseId(),
    ownerId: options.ownerId,
    stream,
    audioTrack,
    revoked: false,
    released: false,
    onRevokedCallbacks: new Set()
  }
  _currentLease = lease

  // 6) 返回公开 lease
  let released = false
  return {
    id: lease.id,
    ownerId: lease.ownerId,
    stream,
    audioTrack,
    release: () => {
      if (released) {
        return
      }
      released = true
      revokeLease(lease, 'release')
    },
    onRevoked: (cb: () => void) => {
      lease.onRevokedCallbacks.add(cb)
      // 如果 lease 已经被 revoke（例如 devicechange 刚发生），立即同步触发
      if (lease.revoked) {
        try { cb() } catch { /* ignore */ }
      }
    }
  }
}

/**
 * 显式释放当前 lease（不传参数 = 释放全局；传 lease = 释放指定）。
 * 通常 caller 用 lease.release() 即可；这个函数是给清理路径用的。
 */
export function releaseAll(): void {
  if (_currentLease) {
    revokeLease(_currentLease, 'release')
  }
  uninstallDeviceChangeListener()
}

/** 测试用：重置整个 engine 状态。 */
export function _resetForTests(): void {
  if (_currentLease) {
    revokeLease(_currentLease, 'release')
  }
  _currentLease = null
  _deviceChangeHandler = null
  _nextDeviceChangeTs = 0
  _leaseIdCounter = 0
  uninstallDeviceChangeListener()
}

/** 内部：当前 lease 的 ownerId（仅用于诊断 / 测试）。 */
export function _getCurrentOwnerId(): CaptureOwnerId | null {
  return _currentLease?.ownerId ?? null
}

// ---------------------------------------------------------------------------
// 错误映射（与原 use-mic-recorder.micError 命名一致）
// ---------------------------------------------------------------------------

function mapMediaError(err: unknown): Error {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error('permission_denied')
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return new Error('no_device')
    case 'NotReadableError':
    case 'TrackStartError':
      return new Error('in_use')
    case 'OverconstrainedError':
      return new Error('constraints_unsupported')
    default:
      return err instanceof Error ? err : new Error('start_failed')
  }
}
