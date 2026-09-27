// src/pairing/session.js
//
// Session/pairing tokens are NOT a security replacement for anything — they
// exist purely so a QR code can carry a short-lived, hard-to-guess pairing
// reference. Uses the Web Crypto API (`crypto.getRandomValues`), which is
// available both in every modern browser and in Node (used by the tests).

const TOKEN_BYTES = 16; // 128 bits of randomness
export const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes, per spec

const BASE64URL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function getCrypto() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('Web Crypto API (crypto.getRandomValues) is not available in this environment');
  }
  return c;
}

/**
 * @returns {string} a URL-safe, 128-bit random token
 */
export function generateSessionId() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  getCrypto().getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += BASE64URL_CHARS[byte % BASE64URL_CHARS.length];
  return out;
}

/**
 * Creates a new pairing session record.
 * @param {number} now epoch ms — injected for testability
 */
export function createSession(now = Date.now()) {
  return {
    id: generateSessionId(),
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    consumedBy: null, // set to the receiver's connection id once paired
  };
}

/**
 * @param {{expiresAt: number, consumedBy: (string|null)}} session
 * @param {number} now
 * @returns {boolean}
 */
export function isSessionValid(session, now = Date.now()) {
  if (!session) return false;
  if (now >= session.expiresAt) return false;
  return true;
}

/**
 * A session is available to pair with if it's not expired and hasn't
 * already been claimed by a receiver.
 */
export function canJoinSession(session, now = Date.now()) {
  return isSessionValid(session, now) && !session.consumedBy;
}

/**
 * Builds the URL encoded into the QR code. Deliberately takes `origin` as a
 * parameter (rather than reading `window.location.origin` itself) so the
 * production domain is never hard-coded and this function stays testable.
 * @param {string} origin e.g. window.location.origin
 * @param {string} sessionId
 */
export function buildPairingUrl(origin, sessionId) {
  const url = new URL(origin);
  url.searchParams.set('session', sessionId);
  return url.toString();
}

/**
 * Extracts a session id from a scanned/opened pairing URL. Returns null if
 * the URL has no session parameter or fails to parse.
 * @param {string} href
 */
export function parseSessionFromUrl(href) {
  try {
    const url = new URL(href);
    return url.searchParams.get('session');
  } catch {
    return null;
  }
}
