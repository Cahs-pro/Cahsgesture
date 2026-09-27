// src/camera/camera.js
//
// Thin wrapper around getUserMedia. Kept deliberately small: it only knows
// how to start/stop a camera stream and translate DOMExceptions into the
// specific, actionable error codes the UI needs (permission denied vs. no
// camera vs. insecure context vs. camera already in use).

export const CameraErrorCode = Object.freeze({
  NOT_SUPPORTED: 'NOT_SUPPORTED',
  INSECURE_CONTEXT: 'INSECURE_CONTEXT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  NO_CAMERA: 'NO_CAMERA',
  IN_USE: 'IN_USE',
  UNKNOWN: 'UNKNOWN',
});

export class CameraError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
  }
}

function isSecureContextOk() {
  // getUserMedia requires HTTPS (or localhost) in every modern browser.
  return typeof window === 'undefined' || window.isSecureContext;
}

/**
 * Requests the front-facing camera for gesture detection.
 * @param {{facingMode?: string}} options
 * @returns {Promise<MediaStream>}
 */
export async function requestCamera({ facingMode = 'user' } = {}) {
  if (!isSecureContextOk()) {
    throw new CameraError(
      CameraErrorCode.INSECURE_CONTEXT,
      'Camera access requires HTTPS. Open this app over a secure (https://) connection.'
    );
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new CameraError(
      CameraErrorCode.NOT_SUPPORTED,
      'Your browser does not support camera access (getUserMedia).'
    );
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    throw mapGetUserMediaError(err);
  }
}

function mapGetUserMediaError(err) {
  const name = err && err.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError(
        CameraErrorCode.PERMISSION_DENIED,
        'Camera access was denied. Gesture-based transfer needs the camera to detect Grab and Put.'
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError(CameraErrorCode.NO_CAMERA, 'No usable camera was found on this device.');
    case 'NotReadableError':
    case 'TrackStartError':
      return new CameraError(
        CameraErrorCode.IN_USE,
        'The camera could not be started — it may already be in use by another app or tab.'
      );
    default:
      return new CameraError(CameraErrorCode.UNKNOWN, (err && err.message) || 'Could not access the camera.');
  }
}

/**
 * Stops every track on a stream. Safe to call multiple times / on null.
 * @param {MediaStream|null|undefined} stream
 */
export function stopCameraStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // already stopped — ignore
    }
  }
}
