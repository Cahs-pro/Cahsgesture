// src/gestures/handLandmarker.js
//
// Real MediaPipe Tasks Vision integration. This is the one module in the
// gesture pipeline that cannot be unit tested outside a browser (it needs
// WebAssembly + WebGL + an actual <video> element), so keep it thin: all
// the interesting classification logic lives in gestureClassifier.js,
// which *is* unit tested.
//
// Loaded from CDN as an ES module — there is no npm install step for the
// frontend. If your deployment target blocks third-party script/module
// hosts, vendor these two URLs yourself and update them here; see the
// README "Known limitations" section.

const TASKS_VISION_VERSION = '0.10.14';
const TASKS_VISION_CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}`;
const HAND_LANDMARKER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

let cachedModulePromise = null;

function loadTasksVisionModule() {
  if (!cachedModulePromise) {
    // Dynamic import from an absolute URL — supported natively by every
    // browser that also supports the WebRTC/getUserMedia APIs this app
    // already depends on.
    cachedModulePromise = import(/* @vite-ignore */ `${TASKS_VISION_CDN}/vision_bundle.mjs`);
  }
  return cachedModulePromise;
}

/**
 * Creates and warms up a HandLandmarker instance ready to run on video
 * frames. Throws if WASM/GPU delegate setup fails — the caller should
 * surface this as "gesture detection unavailable" rather than pretending
 * a gesture was recognized.
 * @returns {Promise<{detect: (video: HTMLVideoElement, timestampMs: number) => {landmarks: (Array|null), confidence: number}, close: () => void}>}
 */
export async function createHandLandmarker({ numHands = 1 } = {}) {
  const { HandLandmarker, FilesetResolver } = await loadTasksVisionModule();

  const filesetResolver = await FilesetResolver.forVisionTasks(`${TASKS_VISION_CDN}/wasm`);

  const landmarker = await HandLandmarker.createFromOptions(filesetResolver, {
    baseOptions: {
      modelAssetPath: HAND_LANDMARKER_MODEL_URL,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands,
  });

  return {
    /**
     * Runs detection on the current video frame.
     * @param {HTMLVideoElement} video
     * @param {number} timestampMs monotonically increasing timestamp (e.g. performance.now())
     */
    detect(video, timestampMs) {
      const result = landmarker.detectForVideo(video, timestampMs);
      const landmarks = result.landmarks && result.landmarks[0] ? result.landmarks[0] : null;
      const confidence =
        result.handedness && result.handedness[0] && result.handedness[0][0]
          ? result.handedness[0][0].score
          : landmarks
            ? 1
            : 0;
      return { landmarks, confidence };
    },
    close() {
      landmarker.close();
    },
  };
}

/**
 * Drives a requestAnimationFrame loop that pulls frames from `video`,
 * runs them through the HandLandmarker, feeds the result into a
 * GestureStateTracker, and reports both the raw per-frame state (for the
 * live "Hand detected" / openness UI) and discrete grab/put events.
 */
export class HandTrackingLoop {
  /**
   * @param {HTMLVideoElement} video
   * @param {{detect: Function}} landmarker
   * @param {import('./gestureClassifier.js').GestureStateTracker} tracker
   * @param {(frame: {event:(string|null), zone:string, openness:(number|null), handDetected:boolean}) => void} onFrame
   */
  constructor(video, landmarker, tracker, onFrame) {
    this.video = video;
    this.landmarker = landmarker;
    this.tracker = tracker;
    this.onFrame = onFrame;
    this._running = false;
    this._rafId = null;
  }

  start() {
    if (this._running) return;
    this._running = true;
    const tick = () => {
      if (!this._running) return;
      if (this.video.readyState >= 2) {
        const { landmarks, confidence } = this.landmarker.detect(this.video, performance.now());
        const frame = this.tracker.update(landmarks, confidence, performance.now());
        this.onFrame(frame);
      }
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  stop() {
    this._running = false;
    if (this._rafId !== null) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }
}
