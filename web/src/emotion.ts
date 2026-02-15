/**
 * Emotion blender — converts state vectors to MocapFrame control points.
 *
 * State vector: { joy: 0.6, anger: 0.2, ... }
 * MocapFrame:   { t, pts: { left_eye_open, mouth_smile, ... } }
 *
 * Each emotion maps to a preset (delta from neutral). Blend = weighted sum + clamp.
 */

// --- MocapFrame types ---

export interface MocapPts {
  left_eye_open: number;
  right_eye_open: number;
  left_pupil_x: number;
  left_pupil_y: number;
  right_pupil_x: number;
  right_pupil_y: number;
  left_brow_height: number;
  left_brow_angle: number;
  right_brow_height: number;
  right_brow_angle: number;
  mouth_open: number;
  mouth_wide: number;
  mouth_smile: number;
  jaw_open: number;
  face_scale: number;
  head_pitch: number;
  head_yaw: number;
  head_roll: number;
}

export interface MocapFrame {
  t: number;
  pts: MocapPts;
}

export type StateVector = Record<string, number>;

// --- Neutral pose ---

const NEUTRAL: MocapPts = {
  left_eye_open: 0.85,
  right_eye_open: 0.85,
  left_pupil_x: 0,
  left_pupil_y: 0,
  right_pupil_x: 0,
  right_pupil_y: 0,
  left_brow_height: 0.03,
  left_brow_angle: 0,
  right_brow_height: 0.03,
  right_brow_angle: 0,
  mouth_open: 0,
  mouth_wide: 0,
  mouth_smile: 0.1,
  jaw_open: 0,
  face_scale: 1.0,
  head_pitch: 0,
  head_yaw: 0,
  head_roll: 0,
};

// --- Valid ranges for clamping ---

const RANGES: Record<keyof MocapPts, [number, number]> = {
  left_eye_open:   [0, 1],
  right_eye_open:  [0, 1],
  left_pupil_x:    [-1, 1],
  left_pupil_y:    [-1, 1],
  right_pupil_x:   [-1, 1],
  right_pupil_y:   [-1, 1],
  left_brow_height:  [-0.5, 0.5],
  left_brow_angle:   [-0.5, 0.5],
  right_brow_height: [-0.5, 0.5],
  right_brow_angle:  [-0.5, 0.5],
  mouth_open:  [0, 1],
  mouth_wide:  [0, 1],
  mouth_smile: [-0.5, 0.5],
  jaw_open:    [0, 1],
  face_scale:  [0.8, 1.2],
  head_pitch:  [-0.3, 0.3],
  head_yaw:    [-0.3, 0.3],
  head_roll:   [-0.2, 0.2],
};

// --- Expression presets (deltas from neutral) ---

type Preset = Partial<MocapPts>;

const PRESETS: Record<string, Preset> = {
  joy: {
    mouth_smile: 0.4,
    left_eye_open: -0.1,
    right_eye_open: -0.1,
    left_brow_height: 0.08,
    right_brow_height: 0.08,
  },
  sadness: {
    mouth_smile: -0.35,
    left_brow_height: 0.15,
    right_brow_height: 0.15,
    left_brow_angle: 0.12,
    right_brow_angle: -0.12,
    left_eye_open: -0.15,
    right_eye_open: -0.15,
  },
  anger: {
    mouth_smile: -0.2,
    left_brow_height: -0.2,
    right_brow_height: -0.2,
    left_brow_angle: -0.15,
    right_brow_angle: 0.15,
    jaw_open: 0.08,
  },
  fear: {
    left_eye_open: 0.15,
    right_eye_open: 0.15,
    left_brow_height: 0.3,
    right_brow_height: 0.3,
    mouth_open: 0.25,
    jaw_open: 0.15,
  },
  surprise: {
    left_eye_open: 0.15,
    right_eye_open: 0.15,
    left_brow_height: 0.35,
    right_brow_height: 0.35,
    mouth_open: 0.35,
    jaw_open: 0.2,
  },
  disgust: {
    mouth_smile: -0.15,
    left_brow_height: -0.1,
    right_brow_height: 0.1,
    left_eye_open: -0.1,
    right_eye_open: -0.05,
    mouth_open: 0.05,
  },
  confidence: {
    mouth_smile: 0.12,
    left_eye_open: -0.05,
    right_eye_open: -0.05,
    head_pitch: -0.02,
  },
  uncertainty: {
    left_brow_height: 0.15,
    right_brow_height: -0.08,
    mouth_smile: -0.05,
    head_roll: 0.03,
  },
  thinking: {
    left_brow_height: 0.12,
    right_brow_height: -0.05,
    left_eye_open: -0.1,
    right_eye_open: -0.1,
    mouth_smile: -0.08,
    left_pupil_x: 0.3,
    right_pupil_x: 0.3,
    left_pupil_y: -0.2,
    right_pupil_y: -0.2,
  },
  excitement: {
    mouth_open: 0.15,
    left_eye_open: 0.1,
    right_eye_open: 0.1,
    left_brow_height: 0.25,
    right_brow_height: 0.25,
    mouth_smile: 0.25,
  },
  calm: {
    mouth_smile: 0.05,
    left_eye_open: -0.1,
    right_eye_open: -0.1,
  },
  urgency: {
    left_eye_open: 0.1,
    right_eye_open: 0.1,
    left_brow_height: -0.1,
    right_brow_height: -0.1,
    jaw_open: 0.05,
  },
  reverence: {
    head_pitch: 0.04,
    left_eye_open: -0.1,
    right_eye_open: -0.1,
    mouth_smile: 0.08,
  },
};

// --- Core functions ---

const ptsKeys = Object.keys(NEUTRAL) as (keyof MocapPts)[];

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

/** Blend a state vector into a MocapFrame using preset deltas. */
export function blend(sv: StateVector): MocapFrame {
  const result = { ...NEUTRAL };

  for (const [emotion, weight] of Object.entries(sv)) {
    const preset = PRESETS[emotion];
    if (!preset || weight === 0) continue;
    const w = clamp(weight, 0, 1);

    for (const key of ptsKeys) {
      const delta = preset[key];
      if (delta !== undefined) {
        result[key] += delta * w;
      }
    }
  }

  // Clamp all values
  for (const key of ptsKeys) {
    const [lo, hi] = RANGES[key];
    result[key] = clamp(result[key], lo, hi);
  }

  return { t: Date.now(), pts: result };
}

/** Linearly interpolate between two MocapPts. */
export function lerp(from: MocapPts, to: MocapPts, t: number): MocapPts {
  const result = { ...from };
  const clamped = clamp(t, 0, 1);
  for (const key of ptsKeys) {
    result[key] = from[key] + (to[key] - from[key]) * clamped;
  }
  return result;
}

// --- EmotionDriver (stateful interpolator) ---

export class EmotionDriver {
  private current: MocapPts;
  private target: MocapPts;
  private transitionMs: number;
  private decayMs: number;
  private lastUpdateTime: number;
  private transitionStart: number;

  constructor(transitionMs = 200, decayMs = 2000) {
    this.current = { ...NEUTRAL };
    this.target = { ...NEUTRAL };
    this.transitionMs = transitionMs;
    this.decayMs = decayMs;
    this.lastUpdateTime = Date.now();
    this.transitionStart = Date.now();
  }

  /** Set a new target from a state vector. */
  update(sv: StateVector): void {
    const frame = blend(sv);
    this.target = frame.pts;
    this.transitionStart = Date.now();
    this.lastUpdateTime = Date.now();
  }

  /** Get current MocapFrame (call in animation loop). */
  frame(): MocapFrame {
    const now = Date.now();

    // Decay to neutral if no updates for a while
    const sinceUpdate = now - this.lastUpdateTime;
    if (sinceUpdate > this.decayMs) {
      const decayT = clamp((sinceUpdate - this.decayMs) / this.transitionMs, 0, 1);
      const eased = easeOut(decayT);
      this.target = lerp(this.target, NEUTRAL, eased);
    }

    // Interpolate current toward target
    const elapsed = now - this.transitionStart;
    const t = clamp(elapsed / this.transitionMs, 0, 1);
    const eased = easeOut(t);
    this.current = lerp(this.current, this.target, eased);

    return { t: now, pts: this.current };
  }
}

/** Cubic ease-out: fast start, smooth deceleration. */
function easeOut(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

// --- IdleAnimator (breathing, blinking, eye drift) ---

/** Seeded pseudo-random number generator (simple LCG). */
class SeededRng {
  private state: number;
  constructor(seed: number) { this.state = seed; }
  next(): number {
    this.state = (this.state * 1664525 + 1013904223) & 0xffffffff;
    return (this.state >>> 0) / 0xffffffff;
  }
}

/**
 * Adds organic idle motion to any MocapPts: breathing, blinking,
 * subtle eye drift, and micro head movements. Always running.
 * Ported from visage/old/interp.py IdleAnimator.
 */
export class IdleAnimator {
  private rng: SeededRng;
  private time = 0;
  private nextBlink: number;
  private blinking = false;
  private blinkT = 0;
  private blinkDuration = 0.15;

  constructor(seed = 42) {
    this.rng = new SeededRng(seed);
    this.nextBlink = 2.0 + this.rng.next() * 3.0;
  }

  /** Apply idle motion to a MocapPts in-place and return it. dt in seconds. */
  apply(pts: MocapPts, dt: number): MocapPts {
    this.time += dt;

    // --- Breathing: subtle face_scale oscillation ---
    pts.face_scale += 0.008 * Math.sin(this.time * 1.5);

    // --- Blinking ---
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && !this.blinking) {
      this.blinking = true;
      this.blinkT = 0;
      this.nextBlink = 2.0 + this.rng.next() * 4.0;
    }

    if (this.blinking) {
      this.blinkT += dt;
      if (this.blinkT < this.blinkDuration) {
        const blink = Math.sin((this.blinkT / this.blinkDuration) * Math.PI);
        pts.left_eye_open *= (1.0 - blink * 0.95);
        pts.right_eye_open *= (1.0 - blink * 0.95);
      } else {
        this.blinking = false;
      }
    }

    // --- Eye drift: slow sinusoidal gaze wander ---
    pts.left_pupil_x  += 0.008 * Math.sin(this.time * 0.7 + 1.3);
    pts.left_pupil_y  += 0.005 * Math.sin(this.time * 0.5 + 2.7);
    pts.right_pupil_x += 0.008 * Math.sin(this.time * 0.7 + 1.3);
    pts.right_pupil_y += 0.005 * Math.sin(this.time * 0.5 + 2.7);

    // --- Micro head movement: very subtle sway ---
    pts.head_yaw  += 0.003 * Math.sin(this.time * 0.3 + 0.5);
    pts.head_pitch += 0.002 * Math.sin(this.time * 0.4 + 1.8);

    // Clamp everything to valid ranges
    for (const key of ptsKeys) {
      const [lo, hi] = RANGES[key];
      pts[key] = clamp(pts[key], lo, hi);
    }

    return pts;
  }
}

export { NEUTRAL, PRESETS, RANGES };
