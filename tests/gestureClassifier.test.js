import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHandOpenness,
  normalizeOpenness,
  GestureStateTracker,
} from '../src/gestures/gestureClassifier.js';

// Builds a synthetic 21-point landmark array. Only the points the
// classifier actually reads (wrist, middle MCP, four fingertips) are
// placed meaningfully; the rest are filler so the array has the expected
// shape MediaPipe would produce.
function makeHand({ tipDistance }) {
  const landmarks = new Array(21).fill(null).map(() => ({ x: 0, y: 0, z: 0 }));
  landmarks[0] = { x: 0, y: 0, z: 0 }; // WRIST
  landmarks[9] = { x: 0, y: -0.3, z: 0 }; // MIDDLE_MCP -> handScale = 0.3
  for (const tip of [8, 12, 16, 20]) {
    landmarks[tip] = { x: 0, y: -tipDistance, z: 0 };
  }
  return landmarks;
}

const OPEN_HAND = makeHand({ tipDistance: 0.7 }); // ratio ~2.33 -> "open"
const CLOSED_HAND = makeHand({ tipDistance: 0.28 }); // ratio ~0.93 -> "closed"
const AMBIGUOUS_HAND = makeHand({ tipDistance: 0.5 }); // ratio ~1.67 -> mid-range

test('computeHandOpenness: open hand scores higher than closed hand', () => {
  const openRatio = computeHandOpenness(OPEN_HAND);
  const closedRatio = computeHandOpenness(CLOSED_HAND);
  assert.ok(openRatio > closedRatio);
});

test('computeHandOpenness requires 21 landmarks', () => {
  assert.throws(() => computeHandOpenness([{ x: 0, y: 0 }]), RangeError);
});

test('normalizeOpenness clamps to [0, 1]', () => {
  assert.equal(normalizeOpenness(-5), 0);
  assert.equal(normalizeOpenness(100), 1);
});

test('tracker requires stable frames before confirming a baseline (no event on first read)', () => {
  const tracker = new GestureStateTracker({ stableFrames: 5 });
  let lastResult;
  for (let i = 0; i < 5; i++) {
    lastResult = tracker.update(OPEN_HAND, 1, i * 30);
  }
  assert.equal(tracker.confirmedZone, 'open');
  assert.equal(lastResult.event, null); // baseline, not a transition
});

test('a full open -> closed transition emits exactly one "grab" event', () => {
  const tracker = new GestureStateTracker({ stableFrames: 4, cooldownMs: 0 });
  let t = 0;
  const events = [];
  for (let i = 0; i < 4; i++) events.push(tracker.update(OPEN_HAND, 1, (t += 30)).event);
  for (let i = 0; i < 4; i++) events.push(tracker.update(CLOSED_HAND, 1, (t += 30)).event);

  const grabs = events.filter((e) => e === 'grab');
  assert.equal(grabs.length, 1);
});

test('closed -> open after a grab emits exactly one "put" event', () => {
  const tracker = new GestureStateTracker({ stableFrames: 4, cooldownMs: 0 });
  let t = 0;
  const feed = (hand, n) => {
    const out = [];
    for (let i = 0; i < n; i++) out.push(tracker.update(hand, 1, (t += 30)).event);
    return out;
  };

  feed(OPEN_HAND, 4);
  const grabEvents = feed(CLOSED_HAND, 4);
  const putEvents = feed(OPEN_HAND, 4);

  assert.equal(grabEvents.filter((e) => e === 'grab').length, 1);
  assert.equal(putEvents.filter((e) => e === 'put').length, 1);
});

test('a single noisy frame does not trigger a grab (requires stableFrames in a row)', () => {
  const tracker = new GestureStateTracker({ stableFrames: 5, cooldownMs: 0 });
  let t = 0;
  const events = [];
  for (let i = 0; i < 5; i++) events.push(tracker.update(OPEN_HAND, 1, (t += 30)).event);
  // Single stray closed frame, then back to open — should never reach
  // `stableFrames` consecutive closed frames.
  events.push(tracker.update(CLOSED_HAND, 1, (t += 30)).event);
  events.push(tracker.update(OPEN_HAND, 1, (t += 30)).event);
  events.push(tracker.update(CLOSED_HAND, 1, (t += 30)).event);
  events.push(tracker.update(OPEN_HAND, 1, (t += 30)).event);

  assert.ok(!events.includes('grab'));
});

test('staying closed continuously never re-fires a duplicate grab', () => {
  const tracker = new GestureStateTracker({ stableFrames: 3, cooldownMs: 0 });
  let t = 0;
  const events = [];
  for (let i = 0; i < 3; i++) events.push(tracker.update(OPEN_HAND, 1, (t += 30)).event);
  for (let i = 0; i < 20; i++) events.push(tracker.update(CLOSED_HAND, 1, (t += 30)).event);

  assert.equal(events.filter((e) => e === 'grab').length, 1);
});

test('cooldown suppresses a second event fired too soon after the first', () => {
  const tracker = new GestureStateTracker({ stableFrames: 3, cooldownMs: 1000 });
  let t = 0;
  const events = [];
  for (let i = 0; i < 3; i++) events.push(tracker.update(OPEN_HAND, 1, (t += 30)).event); // baseline open
  for (let i = 0; i < 3; i++) events.push(tracker.update(CLOSED_HAND, 1, (t += 30)).event); // grab #1
  // Flip back to open immediately (well within the 1000ms cooldown window)
  for (let i = 0; i < 3; i++) events.push(tracker.update(OPEN_HAND, 1, (t += 30)).event);

  const grabs = events.filter((e) => e === 'grab');
  const puts = events.filter((e) => e === 'put');
  assert.equal(grabs.length, 1);
  // The put is suppressed by cooldown even though the zone did flip back;
  // confirmedZone still updates to 'open' so a later, real put can fire.
  assert.equal(puts.length, 0);
});

test('no hand detected resets pending stability progress and emits no event', () => {
  const tracker = new GestureStateTracker({ stableFrames: 3, cooldownMs: 0 });
  let t = 0;
  for (let i = 0; i < 3; i++) tracker.update(OPEN_HAND, 1, (t += 30));
  const result = tracker.update(null, 0, (t += 30));
  assert.equal(result.handDetected, false);
  assert.equal(result.event, null);
});

test('ambiguous mid-range openness never confirms a zone', () => {
  const tracker = new GestureStateTracker({ stableFrames: 3, cooldownMs: 0 });
  let t = 0;
  for (let i = 0; i < 10; i++) tracker.update(AMBIGUOUS_HAND, 1, (t += 30));
  assert.equal(tracker.confirmedZone, null);
});

test('low confidence frames are treated as no-hand', () => {
  const tracker = new GestureStateTracker({ stableFrames: 3, minDetectionConfidence: 0.6 });
  const result = tracker.update(OPEN_HAND, 0.2, 0);
  assert.equal(result.handDetected, false);
});
