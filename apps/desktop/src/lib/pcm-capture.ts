// Streaming PCM capture for the realtime dialogue voice dock.
//
// Turns a MediaStream into 16 kHz int16 mono PCM chunks without going
// through MediaRecorder, so audio can be pushed to /api/audio/dialogue as
// the user speaks. Prefers AudioWorklet (lower capture latency, off the
// main thread) and falls back to ScriptProcessorNode when AudioWorklet is
// unavailable. A zero-gain tap keeps capture from leaking into speakers.

const DEFAULT_CHUNK_MS = 60
const WORKLET_PROCESSOR_NAME = 'hermes-pcm-chunk'

export interface PcmCaptureOptions {
  stream: MediaStream
  sampleRate?: number
  chunkMs?: number
  onChunk: (pcm: ArrayBuffer) => void
}

/** Linear-resample a Float32 chunk from `fromRate` to `toRate`. */
export function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= 0 || toRate <= 0 || fromRate === toRate) {
    return input.slice()
  }

  const ratio = fromRate / toRate
  const outLen = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)

  for (let index = 0; index < outLen; index += 1) {
    const position = index * ratio
    const i0 = Math.floor(position)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const fraction = position - i0
    out[index] = input[i0]! * (1 - fraction) + input[i1]! * fraction
  }

  return out
}

/** Convert Float32 samples (roughly -1..1) into int16 LE PCM bytes. */
export function float32ToPcm16(samples: Float32Array | number[]): ArrayBuffer {
  const pcm = new Int16Array(samples.length)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.round(samples[index]! * 32_767)
    pcm[index] = Math.max(-32_768, Math.min(32_767, sample))
  }

  return pcm.buffer as ArrayBuffer
}

/** AudioWorklet module source: resample + chunk on the audio thread. */
export function createPcmWorkletSource(targetRate: number, chunkSamples: number): string {
  return `
const TARGET_RATE = ${targetRate};
const CHUNK_SAMPLES = ${chunkSamples};

function resampleLinear(input, fromRate, toRate) {
  if (fromRate <= 0 || toRate <= 0 || fromRate === toRate) {
    return input.slice();
  }
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let index = 0; index < outLen; index += 1) {
    const position = index * ratio;
    const i0 = Math.floor(position);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const fraction = position - i0;
    out[index] = input[i0] * (1 - fraction) + input[i1] * fraction;
  }
  return out;
}

class HermesPcmChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.accumulated = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) {
      return true;
    }

    const resampled = resampleLinear(input, sampleRate, TARGET_RATE);
    const joined = new Float32Array(this.accumulated.length + resampled.length);
    joined.set(this.accumulated);
    joined.set(resampled, this.accumulated.length);
    this.accumulated = joined;

    while (this.accumulated.length >= CHUNK_SAMPLES) {
      const slice = this.accumulated.slice(0, CHUNK_SAMPLES);
      this.accumulated = this.accumulated.slice(CHUNK_SAMPLES);
      const pcm = new Int16Array(slice.length);

      for (let index = 0; index < slice.length; index += 1) {
        const sample = Math.round(slice[index] * 32767);
        pcm[index] = Math.max(-32768, Math.min(32767, sample));
      }

      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('${WORKLET_PROCESSOR_NAME}', HermesPcmChunkProcessor);
`
}

function startScriptProcessorCapture(
  context: AudioContext,
  source: MediaStreamAudioSourceNode,
  silence: GainNode,
  targetRate: number,
  chunkSamples: number,
  onChunk: (pcm: ArrayBuffer) => void
): ScriptProcessorNode {
  const processor = context.createScriptProcessor(4096, 1, 1)
  let accumulated: number[] = []

  processor.onaudioprocess = event => {
    const input = event.inputBuffer.getChannelData(0)
    const resampled = resampleLinear(input, context.sampleRate, targetRate)

    for (const value of resampled) {
      accumulated.push(value)
    }

    while (accumulated.length >= chunkSamples) {
      const slice = accumulated.splice(0, chunkSamples)
      onChunk(float32ToPcm16(slice))
    }
  }

  source.connect(processor)
  processor.connect(silence)
  silence.connect(context.destination)

  return processor
}

export function startPcmCapture(options: PcmCaptureOptions): () => void {
  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
  const Ctor = window.AudioContext || audioWindow.webkitAudioContext

  if (!Ctor) {
    return () => undefined
  }

  const targetRate = options.sampleRate ?? 16_000
  const chunkSamples = Math.max(1, Math.round((targetRate * (options.chunkMs ?? DEFAULT_CHUNK_MS)) / 1_000))
  const context = new Ctor()
  const source = context.createMediaStreamSource(options.stream)
  const silence = context.createGain()
  silence.gain.value = 0

  let disposed = false
  let workletNode: AudioWorkletNode | null = null
  let processor: ScriptProcessorNode | null = null
  let workletUrl: string | null = null

  const stop = () => {
    if (disposed) {
      return
    }

    disposed = true

    try {
      source.disconnect()
    } catch {
      // already disconnected
    }

    try {
      workletNode?.disconnect()
    } catch {
      // already disconnected
    }

    try {
      processor?.disconnect()
    } catch {
      // already disconnected
    }

    try {
      silence.disconnect()
    } catch {
      // already disconnected
    }

    if (workletUrl) {
      URL.revokeObjectURL(workletUrl)
      workletUrl = null
    }

    void context.close().catch(() => undefined)
  }

  const start = async () => {
    if (disposed) {
      return
    }

    try {
      if (!context.audioWorklet) {
        throw new Error('AudioWorklet unavailable')
      }

      const url = URL.createObjectURL(
        new Blob([createPcmWorkletSource(targetRate, chunkSamples)], { type: 'application/javascript' })
      )

      workletUrl = url
      await context.audioWorklet.addModule(url)

      if (disposed) {
        stop()

        return
      }

      workletNode = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME)

      workletNode.port.onmessage = event => {
        if (!disposed) {
          options.onChunk(event.data as ArrayBuffer)
        }
      }

      source.connect(workletNode)
      workletNode.connect(silence)
      silence.connect(context.destination)
    } catch {
      if (disposed) {
        return
      }

      if (workletUrl) {
        URL.revokeObjectURL(workletUrl)
        workletUrl = null
      }

      try {
        workletNode?.disconnect()
      } catch {
        // already disconnected
      }

      workletNode = null

      try {
        source.disconnect()
      } catch {
        // already disconnected
      }

      processor = startScriptProcessorCapture(
        context,
        source,
        silence,
        targetRate,
        chunkSamples,
        options.onChunk
      )
    }
  }

  void start()

  return stop
}
