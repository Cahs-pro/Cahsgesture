// src/config.js
//
// No production domain or signaling host is ever hard-coded in the app.
// The signaling URL is resolved, in priority order, from:
//
//   1. a `?signaling=wss://...` query parameter (handy for local testing)
//   2. `window.GESTURESHARE_CONFIG.signalingUrl`, set in a small inline
//      script at the bottom of index.html — this is the one line you edit
//      after deploying the signaling service from /server (see README)
//   3. a same-origin `wss://<host>/ws` guess, which only works if you are
//      self-hosting a server that terminates both the static site and the
//      WebSocket on the same host/port (NOT the case on plain Vercel
//      static hosting — see README "Signaling architecture")

export function getSignalingUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('signaling');
  if (fromQuery) return fromQuery;

  const fromWindowConfig = window.GESTURESHARE_CONFIG && window.GESTURESHARE_CONFIG.signalingUrl;
  if (fromWindowConfig) return fromWindowConfig;

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${window.location.host}/ws`;
}

export function isDebugMode() {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}
