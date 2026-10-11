// Local speech-energy detection for realtime voice.
//
// The realtime dialogue client currently relies on the server's ASR to notice
// that the user started talking. That adds one round trip before playback can
// be cut. This tiny RMS-based detector watches the same PCM chunks that are
// streamed upstream, so a barge-in can silence the speaker locally within a
// couple of 60ms chunks instead of waiting for ASR.

export interface SpeechEnergyDetectorOptions {
  /** Minimum RMS that counts as speech, regardless of the calibrated floor. */
  minTriggerLevel?: number
  /** Speech trigger = floor x this multiplier. */
  floorMultiplier?: number
  /** Consecutive over-threshold chunks required before firing. */
  sustainedChunks?: number
  /** Exponential smoothing weight for the quiet floor. */
  floorWeight?: number
}

/** Normalized RMS (0..1) of an int16 LE PCM chunk. */
export function pcmRms(data: ArrayBuffer): number {
  const samples = new Int16Array(data)

  if (samples.length === 0) {
    return 0
  }

  let sum = 0

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]! / 32_768
    sum += value * value
  }

  return Math.min(1, Math.sqrt(sum / samples.length))
}

export class SpeechEnergyDetector {
  private floor: number
  private streak = 0

  private readonly minTriggerLevel: number
  private readonly floorMultiplier: number
  private readonly sustainedChunks: number
  private readonly floorWeight: number

  constructor(options: SpeechEnergyDetectorOptions = {}) {
    this.minTriggerLevel = options.minTriggerLevel ?? 0.06
    this.floorMultiplier = options.floorMultiplier ?? 3
    this.sustainedChunks = options.sustainedChunks ?? 2
    this.floorWeight = options.floorWeight ?? 0.1
    this.floor = 0.02
  }

  /** Feed one chunk RMS; returns true once sustained speech is detected. */
  process(level: number): boolean {
    const trigger = Math.max(this.minTriggerLevel, this.floor * this.floorMultiplier)

    if (level >= trigger) {
      this.streak += 1

      if (this.streak >= this.sustainedChunks) {
        this.streak = 0

        return true
      }
    } else {
      this.streak = 0
      this.floor = this.floor * (1 - this.floorWeight) + level * this.floorWeight
    }

    return false
  }

  reset(): void {
    this.streak = 0
    this.floor = 0.02
  }
}
