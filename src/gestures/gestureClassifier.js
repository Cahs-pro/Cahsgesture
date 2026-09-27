// src/gestures/gestureClassifier.js
//
// Turns a stream of MediaPipe HandLandmarker results into two discrete,
// debounced application events: 'grab' (open hand -> fist) and 'put'
// (fist -> open hand). This module never touches the camera or the
// MediaPipe model directly — it only consumes landmark arrays — so it can
// be unit tested with plain synthetic coordinates.
//
// MediaPipe's 21-point hand landmark layout (normalized image coords):
//   0  WRIST
//   1-4   THUMB   (CMC, MCP, IP, TIP)
//   5-8   INDEX   (MCP, PIP, DIP, TIP)
//   9-12  MIDDLE  (MCP, PIP, DIP, TIP)
//   13-16 RING    (MCP, PIP, DIP, TIP)
//   17-20 PINKY   (MCP, PIP, DIP, TIP)

const WRIST = 0;
const MIDDLE_MCP = 9;
const FINGERTIPS = [8, 12, 16, 20]; // index, middle, ring, pinky — thumb excluded (different geometry)

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Scale-invariant "openness" score for one hand: ~0 for a closed fist,
 * ~1+ for a fully open palm. Not clamped here — clamping/mapping to a
 * 0..1 confidence-style score happens in `normalizeOpenness`.
 *
 * Works by comparing each fingertip's distance from the wrist to the
 * distance from wrist to the middle-finger knuckle (a stable proxy for
 * "hand size" that barely changes between an open and closed hand, which
 * makes the ratio robust to how close the hand is to the camera).
 *
 * @param {Array<{x:number,y:number,z?:number}>} landmarks 21 hand landmarks
 * @returns {number}
 */
export function computeHandOpenness(landmarks) {
  if (!Array.isArray(landmarks) || landmarks.length < 21) {
    throw new RangeError('computeHandOpenness expects 21 hand landmarks');
  }
  const wrist = landmarks[WRIST];
  const handScale = dist(wrist, landmarks[MIDDLE_MCP]) || 1e-6;

  const ratios = FINGERTIPS.map((tipIndex) => dist(landmarks[tipIndex], wrist) / handScale);
  return ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
}

// Empirically-reasonable ratio bounds for a relaxed fist vs. a spread palm,
// tuned so the resulting 0..1 score sits close to 0 for a fist and close
// to 1 for an open hand. Exposed so a calibration screen could adjust them.
export const OPENNESS_RATIO_RANGE = Object.freeze({ closed: 1.1, open: 2.6 });

/**
 * Maps a raw openness ratio into a 0..1 score using the calibration range.
 */
export function normalizeOpenness(rawRatio, range = OPENNESS_RATIO_RANGE) {
  const span = range.open - range.closed;
  return Math.max(0, Math.min(1, (rawRatio - range.closed) / span));
}

export const DEFAULT_GESTURE_CONFIG = Object.freeze({
  openThreshold: 0.6, // normalized score at/above this counts as "open"
  closedThreshold: 0.35, // normalized score at/below this counts as "closed"
  minDetectionConfidence: 0.5,
  stableFrames: 6, // consecutive frames required before a zone is "confirmed"
  cooldownMs: 800, // minimum time between two emitted events
});

/**
 * Stateful, per-hand tracker. Feed it one frame at a time via `update()`;
 * it emits at most one of 'grab' / 'put' / null per call, already debounced
 * against single noisy frames and duplicate re-triggers.
 */
export class GestureStateTracker {
  constructor(config = {}) {
    this.config = { ...DEFAULT_GESTURE_CONFIG, ...config };
    this.confirmedZone = config.initialZone ?? null; // 'open' | 'closed' | null
    this._pendingZone = null;
    this._pendingCount = 0;
    this._lastEventAt = -Infinity;
    this.lastOpenness = null;
  }

  _zoneFor(score) {
    if (score >= this.config.openThreshold) return 'open';
    if (score <= this.config.closedThreshold) return 'closed';
    return 'ambiguous';
  }

  /**
   * @param {Array|null} landmarks 21 landmarks for the tracked hand, or
   *   null/undefined if no hand was detected this frame.
   * @param {number} confidence detection confidence for this frame, 0..1
   * @param {number} timestampMs frame timestamp (injectable for tests)
   * @returns {{event: ('grab'|'put'|null), zone: string, openness: (number|null), handDetected: boolean}}
   */
  update(landmarks, confidence = 1, timestampMs = Date.now()) {
    const handDetected = !!landmarks && confidence >= this.config.minDetectionConfidence;

    if (!handDetected) {
      // A dropped frame doesn't erase progress toward stability, but it
      // also can't contribute to it — treat as a neutral no-op frame.
      this._pendingZone = null;
      this._pendingCount = 0;
      return { event: null, zone: 'none', openness: null, handDetected: false };
    }

    const rawRatio = computeHandOpenness(landmarks);
    const openness = normalizeOpenness(rawRatio);
    this.lastOpenness = openness;
    const zone = this._zoneFor(openness);

    if (zone === this._pendingZone) {
      this._pendingCount += 1;
    } else {
      this._pendingZone = zone;
      this._pendingCount = 1;
    }

    let event = null;
    const isStable = this._pendingCount >= this.config.stableFrames;
    const isRealZone = zone === 'open' || zone === 'closed';

    if (isStable && isRealZone && zone !== this.confirmedZone) {
      const previousZone = this.confirmedZone;
      const cooledDown = timestampMs - this._lastEventAt >= this.config.cooldownMs;

      if (previousZone === 'open' && zone === 'closed' && cooledDown) {
        event = 'grab';
        this._lastEventAt = timestampMs;
      } else if (previousZone === 'closed' && zone === 'open' && cooledDown) {
        event = 'put';
        this._lastEventAt = timestampMs;
      }

      // Whether or not an event fired (e.g. still cooling down), once a
      // zone has been held stably it becomes the new baseline — this is
      // what stops the exact same stable pose from re-triggering the
      // instant the cooldown lifts.
      this.confirmedZone = zone;
    }

    return { event, zone, openness, handDetected: true };
  }

  reset() {
    this.confirmedZone = null;
    this._pendingZone = null;
    this._pendingCount = 0;
    this._lastEventAt = -Infinity;
    this.lastOpenness = null;
  }
}
