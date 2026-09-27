// src/pairing/qr.js
//
// QR generation uses the `qrcode` npm package, scanning uses `jsqr` — both
// loaded as ES modules straight from a CDN (esm.sh converts any npm
// package to a browser-native ES module on the fly), so there is no
// bundler and no npm install step for the frontend. If your deployment
// target blocks that CDN, vendor these two files locally and change the
// import specifiers below — nothing else in the app needs to change.
//
// The QR payload is ONLY the pairing URL (session id + origin). It never
// contains file data — see pairing/session.js for what actually goes in it.

const QRCODE_CDN = 'https://esm.sh/qrcode@1.5.3';
const JSQR_CDN = 'https://esm.sh/jsqr@1.4.0';

let qrcodeModulePromise = null;
let jsQrModulePromise = null;

function loadQrcodeModule() {
  if (!qrcodeModulePromise) qrcodeModulePromise = import(/* @vite-ignore */ QRCODE_CDN);
  return qrcodeModulePromise;
}

function loadJsQrModule() {
  if (!jsQrModulePromise) jsQrModulePromise = import(/* @vite-ignore */ JSQR_CDN);
  return jsQrModulePromise;
}

/**
 * Renders a QR code encoding `text` onto the given <canvas> element.
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 */
export async function renderPairingQr(canvas, text) {
  const mod = await loadQrcodeModule();
  const QRCode = mod.default || mod;
  await QRCode.toCanvas(canvas, text, {
    width: 280,
    margin: 2,
    color: { dark: '#eaf2f5', light: '#00000000' },
  });
}

/**
 * Continuously scans camera frames from `video` for a QR code, calling
 * `onDecoded(text)` the first time one is found, then stopping itself.
 * Returns a function that cancels the scan early.
 * @param {HTMLVideoElement} video
 * @param {(text: string) => void} onDecoded
 * @returns {() => void} cancel function
 */
export function scanQrFromVideo(video, onDecoded) {
  let cancelled = false;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  loadJsQrModule().then((mod) => {
    const jsQR = mod.default || mod;

    const tick = () => {
      if (cancelled) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });
        if (code && code.data) {
          cancelled = true;
          onDecoded(code.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  return () => {
    cancelled = true;
  };
}
