# GestureShare

**Grab it. Move it. Put it.**

Pair two devices with a QR code. Select an image on one. Make a fist over
it to grab it — the image starts moving to the other device in the
background, over a direct WebRTC connection, before you've even finished
moving your hand. Open your hand near the second device to put it down,
and it appears there instantly.

No upload. No account. No typed room codes. The file never touches a
server — it travels peer-to-peer over a WebRTC data channel.

---

## Table of contents

- [Project overview](#project-overview)
- [Features](#features)
- [Architecture](#architecture)
- [User flow](#user-flow)
- [Gesture system](#gesture-system)
- [WebRTC](#webrtc)
- [Signaling architecture](#signaling-architecture)
- [Transfer protocol](#transfer-protocol)
- [Privacy](#privacy)
- [Security](#security)
- [Local development](#local-development)
- [Testing](#testing)
- [Deployment — GitHub → Vercel](#deployment--github--vercel)
- [Deployment — Netlify (alternative to Vercel)](#deployment--netlify-alternative-to-vercel)
- [Deployment — signaling service](#deployment--signaling-service)
- [Environment / configuration](#environment--configuration)
- [Browser compatibility](#browser-compatibility)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [What was and wasn't tested](#what-was-and-wasnt-tested)

---

## Project overview

GestureShare is a static, zero-build web app plus one small standalone
signaling service. The frontend is plain HTML/CSS/JavaScript (ES modules,
no bundler, no framework) so deploying it is just "push static files
somewhere." Gesture recognition runs entirely client-side using MediaPipe's
HandLandmarker; the actual file bytes travel over an RTCDataChannel,
never through any server.

## Features

Real and working, as implemented in this repository:

- QR pairing between two devices, no typed codes
- Real camera-based hand-landmark tracking (MediaPipe Tasks Vision)
- A custom, temporally-smoothed, debounced GRAB/PUT classifier (not a
  MediaPipe built-in gesture name — see [Gesture system](#gesture-system))
- Real `RTCPeerConnection` / `RTCDataChannel` WebRTC transport
- Chunked binary transfer with backpressure (`bufferedAmount` /
  `bufferedamountlow`), progress, and speed/ETA calculated from actual
  bytes transferred — never simulated
- A file fully buffers in the background the instant GRAB fires, so PUT
  is a reveal, not the start of a download
- Explicit, illegal-transition-rejecting state machines for both roles
- Filename sanitization and `textContent`-only rendering (no `innerHTML`
  of anything peer-supplied)
- PWA manifest + service worker (app-shell caching only)
- Debug overlay (`?debug=1`) showing ICE/connection/data-channel state and
  live gesture confidence

Deliberately **not** implemented (see [Known limitations](#known-limitations)):

- A bundled TURN server (STUN-only ICE config is included)
- Gesture-password / gesture-sequence authentication — an earlier product
  concept this build explicitly does not implement (see the "critical
  product concept" note below)
- Multi-file / arbitrary-file-type transfer — this build is scoped to
  images, per the brief

> **Note on scope:** an earlier draft of this brief described a different
> product (typed room codes, a multi-gesture "password" sequence hashed
> for authentication). This build implements the **current** brief:
> QR pairing + a single GRAB gesture + a single PUT gesture, with no
> gesture-based authentication of any kind. The gesture here is an
> interaction trigger, not a credential.

## Architecture

```text
Device A (sender)                              Device B (receiver)
──────────────────                             ────────────────────
index.html + src/*.js  ◄── same static files ──►  index.html + src/*.js
        │                                                  │
        │ getUserMedia + HandLandmarker                    │ getUserMedia + HandLandmarker
        │ (GRAB classifier)                                │ (PUT classifier)
        │                                                  │
        └──────────────┐                    ┌──────────────┘
                        ▼                    ▼
                  Signaling WebSocket (server/)
                  — only pairing/offer/answer/ICE —
                        │                    │
                        └───── RTCPeerConnection ─────┘
                                     │
                              RTCDataChannel
                        (control JSON + binary chunks —
                         the actual image bytes, P2P)
```

Everything under `src/` is a plain ES module, imported directly by the
browser — there is no bundler and no build step. The only place `npm
install` matters for *running* the app is the standalone signaling
service in `server/`.

## User flow

1. **Device A**: open the app → "Pair Device" → a QR code appears
   (encodes `https://<your-deployment>/?session=<random-id>`, nothing else).
2. **Device B**: open the app → "Scan QR" (in-app camera scanner) — or
   scan the code with the OS camera app, which opens the same URL and is
   picked up automatically via the `?session=` parameter.
3. Both devices connect to the signaling service, exchange a WebRTC
   offer/answer + ICE candidates, and open a data channel. Both show
   "Device connected."
4. **Device A** selects an image. Its camera starts; the image and a
   small mirrored self-view are shown together.
5. Device A makes a fist over the image. The moment this is confirmed:
   - Device A shows "File grabbed" and starts sending the file in the
     background immediately.
   - Device B is told over the data channel and **automatically** switches
     to a "Put here" screen — no button, no manual accept.
6. Device B's camera starts; while it waits for a PUT gesture, the file
   keeps buffering in the background.
7. Device B opens their hand (release gesture). The moment this is
   confirmed:
   - If the file already fully arrived, the image is revealed instantly.
   - If a few chunks are still in flight, they finish over the same
     already-open channel and the image reveals the instant they land —
     nothing restarts.
8. Device A is notified the PUT happened and returns to "ready to send
   another file."

## Gesture system

`src/gestures/gestureClassifier.js` (pure logic, fully unit tested,
zero DOM/browser dependencies) implements:

- **`computeHandOpenness(landmarks)`** — from MediaPipe's 21 hand
  landmarks, averages the distance from each of the four (non-thumb)
  fingertips to the wrist, normalized by the wrist-to-middle-knuckle
  distance (a stable, scale-invariant proxy for hand size). A closed fist
  scores low; an open palm scores high.
- **`GestureStateTracker`** — a small state machine over that score:
  - classifies each frame into `open` / `closed` / `ambiguous` zones
    against configurable thresholds,
  - requires `stableFrames` consecutive frames in the same zone before
    treating it as confirmed (rejects single noisy frames),
  - emits `'grab'` only on a confirmed **open → closed** transition, and
    `'put'` only on a confirmed **closed → open** transition,
  - enforces a `cooldownMs` between emitted events so holding a fist
    doesn't repeatedly re-fire GRAB.

Both devices run the exact same tracker — Device A's `'grab'` event
means "grab," Device B's `'put'` event means "put." Default configuration:

```js
{
  openThreshold: 0.6,
  closedThreshold: 0.35,
  minDetectionConfidence: 0.5,
  stableFrames: 6,
  cooldownMs: 800,
}
```

These thresholds are a reasonable starting point, not a calibrated
constant — real hands, lighting, and camera quality vary, and the numbers
above have **not** been validated against physical hardware in this
build (see [What was and wasn't tested](#what-was-and-wasnt-tested)). If
GRAB/PUT feels too sensitive or not sensitive enough on your device,
adjust `openThreshold` / `closedThreshold` / `stableFrames` in
`src/main.js`'s `new GestureStateTracker()` call.

The actual on-device model (`src/gestures/handLandmarker.js`) loads
MediaPipe's `HandLandmarker` from a CDN — see
[Known limitations](#known-limitations).

## WebRTC

`src/webrtc/peerConnection.js` wraps a real `RTCPeerConnection`:
STUN-only ICE (`stun:stun.l.google.com:19302` +
`stun:stun1.l.google.com:19302`), offer/answer exchange, ICE candidate
relay through the signaling client, and a single `RTCDataChannel`
(`ordered: true`) used for both control messages and binary chunks.

`src/webrtc/dataChannelTransfer.js` drives the actual bytes:
`FileSender` chunks the file (`src/transfer/chunking.js`, 32 KB frames by
default, each prefixed with a 4-byte index) and respects
`dataChannel.bufferedAmount`, pausing until `bufferedamountlow` fires
before sending more; `FileReceiver` reassembles chunks (order-independent,
duplicate-safe) into a `Blob` and hands back an object URL.

## Signaling architecture

WebRTC needs some out-of-band channel to exchange the initial offer,
answer, and ICE candidates — that's all this signaling service does. It
**never** sees file bytes.

**Why it's a separate deployment from the Vercel frontend:** Vercel's
serverless functions run per-request and don't hold a long-lived
WebSocket connection open. A `ws`-based Node process needs a host that
keeps a process running — Render, Fly.io, Railway, a small VPS, or
similar all work. `server/` is a complete, standalone Node project for
exactly that:

```bash
cd server
npm install
npm start   # ws://localhost:8787 by default, or $PORT
```

Deploy that directory to your host of choice, then point the frontend at
it — see [Environment / configuration](#environment--configuration).

The routing/pairing logic (`server/roomManager.js`) is deliberately
decoupled from the `ws` library so it's unit-testable without a real
socket; `server/server.js` is the thin adapter that wires real
connections into it. Rooms are in-memory only, keyed by the session id
that was already embedded in the QR code — there is no database. An
unclaimed room expires after 10 minutes; a claimed room is torn down the
moment either peer disconnects.

## Transfer protocol

Two channels, two different jobs:

| Channel | Carries |
|---|---|
| Signaling WebSocket | `JOIN`, `PEER_JOINED`, `OFFER`, `ANSWER`, `ICE_CANDIDATE`, `PEER_LEFT`, `SESSION_EXPIRED`, `SESSION_FULL` |
| WebRTC data channel | `GRAB_START`, `FILE_METADATA`, binary chunks, `TRANSFER_COMPLETE`, `TRANSFER_CANCELLED`, `PUT_DETECTED` |

`GRAB_START` fires the instant GRAB is confirmed, before the file is
even fully chunked — it's what makes Device B's screen switch
automatic. `FILE_METADATA` (chunk size, total chunks) follows immediately
after, then the binary chunks themselves.

## Privacy

- The image never leaves the two paired devices except as encrypted
  WebRTC traffic between them.
- Nothing is uploaded to, or stored on, any server.
- The signaling service only ever sees session ids, SDP offers/answers,
  and ICE candidates — never file names, sizes, or bytes.
- No account, no email, no password, no analytics, no tracking.
- **On networks where a direct peer connection can't be established**
  (symmetric NAT, some corporate/campus firewalls), plain WebRTC with
  only STUN configured will simply **fail to connect** rather than
  silently falling back to a relay — this build does not include a TURN
  server. If you add one (see `src/webrtc/peerConnection.js`), traffic
  through it is still end-to-end DTLS/SRTP-encrypted, but is relayed
  through a third-party machine rather than going device-to-device.

## Security

- Filenames are sanitized (`src/utils/sanitize.js`) before display or
  use as a download name — path separators and control characters are
  stripped, length is bounded, and the result is always non-empty.
- All peer-supplied text is rendered with `textContent`, never
  `innerHTML`.
- Session/pairing tokens are generated with `crypto.getRandomValues`
  (128 bits), are single-use (a room is deleted once claimed and either
  side disconnects), and expire after 10 minutes unclaimed.
- The signaling server validates message shape and caps message size
  (64 KB) before touching a message.
- No `eval`, no dynamic HTML construction from network data.

## Local development

The frontend has **zero** npm dependencies — MediaPipe, `qrcode`, and
`jsQR` are loaded as ES modules directly from a CDN in the browser, so
there's nothing to install to run it:

```bash
npx serve .        # or any static file server; camera access needs HTTPS
                    # or http://localhost specifically
```

Then, in another terminal, start the signaling service (this one *does*
need `npm install`, since a real WebSocket server implementation isn't
something you can load from a browser-facing CDN):

```bash
cd server
npm install
npm start
```

Open the printed local URL on two devices (or two browser profiles) on
the same network, and point the frontend at your local signaling server
with `?signaling=ws://<your-computer's-LAN-IP>:8787` (see
[Environment / configuration](#environment--configuration) — camera
access from a phone will also require your computer to serve over HTTPS
or for you to test on `localhost` only from a desktop browser).

## Testing

```bash
npm test
```

This runs Node's built-in test runner (`node --test`) over everything in
`tests/` — **47 tests, all passing**, with zero external test
dependencies. What's covered:

- `tests/chunking.test.js` — chunk/reassemble round-trips, out-of-order
  delivery, duplicate-chunk safety, out-of-range rejection, progress math
- `tests/gestureClassifier.test.js` — openness scoring, stable-frame
  debounce, single-noisy-frame rejection, no-duplicate-grab-while-held,
  cooldown suppression, ambiguous-zone handling, low-confidence-as-no-hand
- `tests/stateMachine.test.js` — full sender/receiver happy paths,
  illegal-transition rejection, error recovery, transition/reject events
- `tests/session.test.js` — token randomness/uniqueness, expiry, one-time
  join, URL round-tripping with no hard-coded domain
- `tests/sanitize.test.js` — path stripping, control-character stripping,
  never-empty, length bounding, `textContent`-only rendering
- `tests/roomManager.test.js` — pairing/relay/leave/expiry logic for the
  signaling server, using mock connections (no real socket needed)

What is **not**, and cannot be, covered by this suite: anything touching
a real camera, a real `RTCPeerConnection`, or a real browser DOM. See the
next section.

## Deployment — GitHub → Vercel

The frontend is a plain static site — no build step, no framework to
detect.

```text
1. Push this repository to GitHub.
2. In Vercel: Add New → Project → Import this repository.
3. Framework preset: "Other" / static — no build command needed.
4. Deploy.
```

`npm install` / `npm run build` / `npm start` are **not** required on
your own machine for this to work — Vercel just serves the static files.

**`vercel.json` matters here — don't remove it.** Vercel's zero-config
"Other" preset defaults its Output Directory to `public/` *whenever a
folder named `public` exists in the repo*, regardless of where
`index.html` actually lives. This project has a `public/` folder (icons,
manifest) alongside a root-level `index.html`, so without an explicit
override Vercel serves only the contents of `public/` and every real
route 404s ("This page doesn't exist"). `vercel.json` pins
`"outputDirectory": "."` to force it to serve from the actual project
root. If you ever see that 404 after deploying, check Project Settings →
Build & Development Settings → Output Directory in the Vercel dashboard
and make sure it's blank/`.` rather than `public`.

After deploying, set `window.GESTURESHARE_CONFIG.signalingUrl` (bottom of
`index.html`) to your deployed signaling service's `wss://` URL and
redeploy — see the next two sections.

## Deployment — Netlify (alternative to Vercel)

Netlify doesn't have Vercel's "guess `public/` as the output" behavior,
but `netlify.toml` pins `publish = "."` explicitly anyway so there's no
ambiguity either way:

```text
1. Push this repository to GitHub (or drag-and-drop the folder into
   Netlify Drop for a one-off deploy with no git needed).
2. In Netlify: Add new site → Import an existing project → pick the repo.
3. Build command: leave empty. Publish directory: leave as "." (netlify.toml
   already sets this).
4. Deploy.
```

Same as Vercel: set `window.GESTURESHARE_CONFIG.signalingUrl` in
`index.html` to your signaling service's `wss://` URL afterwards, and
redeploy. Netlify does not run a persistent WebSocket server either —
`server/` still needs to go to Render/Fly.io/Railway/etc. regardless of
which one hosts the frontend.

## Deployment — signaling service

Deploy `server/` to any host that runs a persistent Node process, e.g.:

```text
Render / Railway / Fly.io:
  1. New service → point at this repo, root directory "server".
  2. Build command: npm install
  3. Start command: npm start
  4. Note the wss:// URL it gives you.
```

## Environment / configuration

No secrets are required. The one thing to configure post-deploy:

```js
// index.html, near the bottom
window.GESTURESHARE_CONFIG = {
  signalingUrl: 'wss://your-signaling-host.example.com',
};
```

`PORT` is the only environment variable the signaling service reads
(most hosts set this for you automatically).

## Browser compatibility

Targets current Chrome, Edge, Firefox, and Safari (desktop + mobile).
Camera access (`getUserMedia`) requires a secure context — HTTPS in
production, which Vercel provides automatically, or `http://localhost`
for local development. Requirements to actually run GestureShare:

- `getUserMedia` (camera)
- `RTCPeerConnection` + `RTCDataChannel` with binary support
- WebAssembly + (ideally) WebGL, for MediaPipe's hand-tracking model
- Dynamic `import()` of a remote ES module URL

All are broadly supported in current major browsers; iOS Safari in
particular has historically been pickier about `getUserMedia` inside
non-standalone/PWA contexts and about WebRTC on older versions — this
has not been physically verified on iOS in this build (see below).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Camera access is required…" | Permission denied, or not on HTTPS/localhost |
| "No usable camera was found" | Device has no camera, or it's disabled at the OS level |
| Stuck on "Waiting for the other device…" | Signaling URL not configured, signaling service not running, or a firewall is blocking the WebSocket |
| Stuck on "negotiating connection…" | Likely a NAT/firewall that STUN alone can't traverse — see [Known limitations](#known-limitations) re: TURN |
| GRAB/PUT doesn't trigger | Lighting/hand distance affects the openness score — try adjusting thresholds (see [Gesture system](#gesture-system)) |
| "That session is already paired" | Someone else already scanned that QR code |
| Vercel shows "This page doesn't exist" (404) on every route right after deploy | Output Directory got set to `public/` instead of the project root — see the `vercel.json` note in [Deployment — GitHub → Vercel](#deployment--github--vercel) |

## Known limitations

Stated plainly, as required by the brief:

- **No TURN server is bundled.** STUN-only ICE will fail to connect two
  devices on networks with symmetric NAT or restrictive firewalls. Add a
  TURN server in `src/webrtc/peerConnection.js` if you need one.
- **The signaling service must be deployed separately from Vercel.**
  Vercel's serverless model does not support the long-lived WebSocket
  connection a real-time signaling server needs.
- **Gesture thresholds are heuristic defaults, not calibrated constants.**
  They were designed against the known geometry of MediaPipe's hand
  landmark output and unit-tested against synthetic landmark data, but
  **not** tuned against real hands on real hardware in this build.
- **MediaPipe, `qrcode`, and `jsQR` load from third-party CDNs at
  runtime.** If your deployment environment blocks `cdn.jsdelivr.net` or
  `esm.sh`, gesture detection and QR generation/scanning will not load.
  Vendor them locally if that's a concern (see comments in
  `src/gestures/handLandmarker.js` and `src/pairing/qr.js`).
- **Scoped to images.** The transfer engine itself is file-type-agnostic
  (it chunks arbitrary bytes), but the UI/reveal experience is built and
  tested around images specifically, per the brief.
- **No lockfile is included for the root project** because it has zero
  npm dependencies by design (everything frontend-facing is a CDN ES
  module import, not an npm package) — there's nothing for a lockfile to
  pin. `server/package.json` does list a real dependency (`ws`) and
  would get a lockfile from `npm install` at deploy time.

## What was and wasn't tested

Built and verified in this environment:

- All 47 automated unit tests pass (`npm test`), covering every module
  that doesn't require a browser or a network socket: chunking/reassembly,
  the gesture classifier, both state machines, session tokens,
  sanitization, and the signaling room-management logic.
- Every JavaScript file in the project was syntax-checked
  (`node --check`).

**Not performed, and not claimed to have been performed:**

- **No physical two-device test.** This build was produced in a
  sandboxed environment with no camera, no browser, and no second device
  available to it.
- **No live end-to-end test of the signaling server or a real WebRTC
  connection.** The environment this was built in has outbound network
  access disabled, so `npm install ws` (and therefore actually starting
  `server/server.js`) could not be run here. The server's *routing
  logic* is unit tested via mock connections; the real `ws`-based
  networking code around it (`server/server.js`) has been written
  carefully and reviewed, but not executed.
- **No live verification that the MediaPipe/`qrcode`/`jsQR` CDN URLs
  resolve and behave exactly as documented** — again, no network access
  in this environment. The API usage matches each library's documented
  interface at the pinned versions referenced in the code, but hasn't
  been exercised against the live CDN responses.
- **No visual/UX review in an actual browser.** The HTML/CSS was written
  and reviewed by hand, not rendered and screenshotted.

If you hit an issue that traces back to one of these untested paths,
that's expected — please treat this as a solid, carefully-built starting
point rather than a verified-in-production release, and test the
camera/WebRTC/signaling path on real devices before relying on it.
