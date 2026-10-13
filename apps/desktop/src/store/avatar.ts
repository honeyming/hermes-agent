import { atom } from 'nanostores'

import { persistBoolean, storedBoolean } from '@/lib/storage'

/**
 * Hermes-native virtual avatar (standalone always-on-top panel). The avatar is
 * opt-in: hidden by default and only shown when the user enables it from
 * Settings → Appearance. The v2 key also guarantees that the old always-on
 * default from pre-upgrade installs can never resurrect the panel.
 */
const AVATAR_ENABLED_KEY = 'hermes.desktop.avatar.enabled.v2'

export const $avatarEnabled = atom(storedBoolean(AVATAR_ENABLED_KEY, false))

export const setAvatarEnabled = (enabled: boolean) => {
  $avatarEnabled.set(enabled)
  persistBoolean(AVATAR_ENABLED_KEY, enabled)
}

// Portrait aspect (752x1360 source) sized for a small desktop companion panel.
export const AVATAR_WINDOW_W = 220
export const AVATAR_WINDOW_H = 400

/**
 * Live mouth-open level (0..1) driven by voice energy. The overlay renderer
 * reads this to time jaw/scale animation; producers (voice-metrics listener,
 * TTS playback analyser, etc.) feed it from the main renderer. When the
 * overlay loads before any producer has run, the renderer falls back to a
 * procedural oscillation while `speaking` is true so the avatar visibly
 * reacts even before the first audio chunk lands.
 */
export const $avatarMouthLevel = atom<number>(0)

export const setAvatarMouthLevel = (level: number) => {
  const clamped = Math.max(0, Math.min(1, level))

  // Only emit when the value moves meaningfully to avoid waking React on every
  // 60fps tick when nothing is happening.
  if (Math.abs(clamped - $avatarMouthLevel.get()) >= 0.02) {
    $avatarMouthLevel.set(clamped)
  }
}

/**
 * Coarse emotional state used to drive idle/listening/speaking pose changes.
 * The renderer derives this locally from $avatarMouthLevel + $busy +
 * $awaitingResponse, so there's no store atom to write — anything else would
 * race with the source-of-truth signals.
 */
export type AvatarEmotion = 'idle' | 'listening' | 'speaking' | 'thinking'

/**
 * Pointer on the last interaction (click / double-click / drag) the avatar
 * received. The renderer reads this through useStore and runs a transient CSS
 * animation. Each interaction bumps the timestamp + kind so quick repeats
 * re-trigger the animation cleanly even when the state hasn't actually
 * changed.
 */
export type AvatarInteractionEvent = {
  kind: AvatarInteractionKind
  at: number
}

export const $avatarLastInteraction = atom<AvatarInteractionEvent | null>(null)

export type AvatarInteractionKind = 'click' | 'double-click' | 'drag'

export const notifyAvatarInteraction = (kind: AvatarInteractionKind) => {
  $avatarLastInteraction.set({ kind, at: Date.now() })
}
