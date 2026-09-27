// sw.js — must live at the project root so its scope covers the whole
// origin (see README "PWA" section for why /public/sw.js would not work).
//
// Caching strategy, deliberately narrow:
//  - Precache and cache-first the app shell (HTML/CSS/JS/manifest/icons).
//  - Bump CACHE_NAME on every deploy so old shells are dropped on activate.
//  - Never intercept cross-origin requests (Google Fonts, the MediaPipe
//    WASM/model files, the qrcode/jsQR CDN modules, or the signaling
//    WebSocket) — those are large, versioned by URL already, and must
//    never be served stale.
//  - Never cache anything carrying an actual user file. There is nothing
//    to exclude here by design: files never pass through fetch/XHR, only
//    through the WebRTC data channel, which a service worker cannot see.

const CACHE_VERSION = 'v1';
const CACHE_NAME = `gestureshare-${CACHE_VERSION}`;

const APP_SHELL = [
  '/',
  '/index.html',
  '/src/styles.css',
  '/src/main.js',
  '/src/config.js',
  '/src/app/stateMachine.js',
  '/src/camera/camera.js',
  '/src/gestures/gestureClassifier.js',
  '/src/gestures/handLandmarker.js',
  '/src/webrtc/protocol.js',
  '/src/webrtc/peerConnection.js',
  '/src/webrtc/dataChannelTransfer.js',
  '/src/transfer/chunking.js',
  '/src/pairing/session.js',
  '/src/pairing/signalingClient.js',
  '/src/pairing/qr.js',
  '/src/ui/screens.js',
  '/src/utils/sanitize.js',
  '/public/manifest.json',
  '/public/icons/icon-192.png',
  '/public/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only ever handle same-origin, same-scheme GET requests. Everything
  // else (CDN modules, fonts, the signaling WebSocket) passes straight
  // through to the network, untouched.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Don't cache opaque/error responses.
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      });
    })
  );
});
