import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateSessionId,
  createSession,
  isSessionValid,
  canJoinSession,
  buildPairingUrl,
  parseSessionFromUrl,
  SESSION_TTL_MS,
} from '../src/pairing/session.js';

test('generateSessionId produces sufficiently random, URL-safe tokens', () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(generateSessionId());
  assert.equal(ids.size, 500); // no collisions in 500 draws
  for (const id of ids) {
    assert.match(id, /^[A-Za-z0-9\-_]+$/);
  }
});

test('createSession sets a 10-minute expiry from "now"', () => {
  const now = 1_000_000;
  const session = createSession(now);
  assert.equal(session.expiresAt - session.createdAt, SESSION_TTL_MS);
  assert.equal(session.consumedBy, null);
});

test('isSessionValid respects expiry', () => {
  const session = createSession(0);
  assert.equal(isSessionValid(session, 0), true);
  assert.equal(isSessionValid(session, SESSION_TTL_MS - 1), true);
  assert.equal(isSessionValid(session, SESSION_TTL_MS), false);
  assert.equal(isSessionValid(null, 0), false);
});

test('canJoinSession refuses an already-consumed session', () => {
  const session = createSession(0);
  assert.equal(canJoinSession(session, 100), true);
  session.consumedBy = 'peer-b';
  assert.equal(canJoinSession(session, 100), false);
});

test('buildPairingUrl never hard-codes a domain and round-trips with parseSessionFromUrl', () => {
  const url = buildPairingUrl('https://gestureshare.example.vercel.app', 'abc123XYZ');
  assert.ok(url.startsWith('https://gestureshare.example.vercel.app'));
  assert.equal(parseSessionFromUrl(url), 'abc123XYZ');

  const otherOrigin = buildPairingUrl('https://a-totally-different-domain.app', 'zzz');
  assert.equal(parseSessionFromUrl(otherOrigin), 'zzz');
});

test('parseSessionFromUrl returns null for a garbage or session-less URL', () => {
  assert.equal(parseSessionFromUrl('not a url'), null);
  assert.equal(parseSessionFromUrl('https://example.com/'), null);
});
