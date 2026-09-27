import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomManager, ServerMessageType } from '../server/roomManager.js';

function makeInbox() {
  const messages = [];
  return { messages, send: (msg) => messages.push(msg) };
}

test('a receiver joining after the sender triggers PEER_JOINED to the sender only', () => {
  const rm = new RoomManager();
  const sender = makeInbox();
  const receiver = makeInbox();
  rm.registerConnection('s1', sender.send);
  rm.registerConnection('r1', receiver.send);

  rm.handleJoin('s1', 'session-A', 'sender');
  rm.handleJoin('r1', 'session-A', 'receiver');

  assert.deepEqual(sender.messages, [{ type: ServerMessageType.PEER_JOINED }]);
  assert.deepEqual(receiver.messages, []);
});

test('a second receiver trying to join a full room gets SESSION_FULL', () => {
  const rm = new RoomManager();
  const sender = makeInbox();
  const r1 = makeInbox();
  const r2 = makeInbox();
  rm.registerConnection('s1', sender.send);
  rm.registerConnection('r1', r1.send);
  rm.registerConnection('r2', r2.send);

  rm.handleJoin('s1', 'session-B', 'sender');
  rm.handleJoin('r1', 'session-B', 'receiver');
  rm.handleJoin('r2', 'session-B', 'receiver');

  assert.deepEqual(r2.messages, [{ type: ServerMessageType.SESSION_FULL }]);
});

test('a receiver joining a session that was never created gets SESSION_EXPIRED', () => {
  const rm = new RoomManager();
  const receiver = makeInbox();
  rm.registerConnection('r1', receiver.send);

  rm.handleJoin('r1', 'no-such-session', 'receiver');

  assert.deepEqual(receiver.messages, [{ type: ServerMessageType.SESSION_EXPIRED }]);
});

test('OFFER/ANSWER/ICE_CANDIDATE relay verbatim between the two paired peers', () => {
  const rm = new RoomManager();
  const sender = makeInbox();
  const receiver = makeInbox();
  rm.registerConnection('s1', sender.send);
  rm.registerConnection('r1', receiver.send);
  rm.handleJoin('s1', 'session-C', 'sender');
  rm.handleJoin('r1', 'session-C', 'receiver');

  rm.relay('s1', { type: 'OFFER', sdp: { fake: 'offer' } });
  rm.relay('r1', { type: 'ANSWER', sdp: { fake: 'answer' } });
  rm.relay('s1', { type: 'ICE_CANDIDATE', candidate: { fake: 'candidate-1' } });

  assert.deepEqual(receiver.messages, [
    { type: 'OFFER', sdp: { fake: 'offer' } },
    { type: 'ICE_CANDIDATE', candidate: { fake: 'candidate-1' } },
  ]);
  assert.deepEqual(sender.messages, [
    { type: ServerMessageType.PEER_JOINED },
    { type: 'ANSWER', sdp: { fake: 'answer' } },
  ]);
});

test('relay before pairing is a no-op (no peer to deliver to)', () => {
  const rm = new RoomManager();
  const sender = makeInbox();
  rm.registerConnection('s1', sender.send);
  rm.handleJoin('s1', 'session-D', 'sender');

  assert.doesNotThrow(() => rm.relay('s1', { type: 'OFFER', sdp: {} }));
});

test('handleLeave notifies the remaining peer and tears the room down', () => {
  const rm = new RoomManager();
  const sender = makeInbox();
  const receiver = makeInbox();
  rm.registerConnection('s1', sender.send);
  rm.registerConnection('r1', receiver.send);
  rm.handleJoin('s1', 'session-E', 'sender');
  rm.handleJoin('r1', 'session-E', 'receiver');

  rm.handleLeave('s1');

  assert.deepEqual(receiver.messages, [{ type: ServerMessageType.PEER_LEFT }]);
  assert.equal(rm.roomCount, 0);
});

test('an unclaimed room expires and notifies the waiting sender', () => {
  const rm = new RoomManager({ ttlMs: 1000 });
  const sender = makeInbox();
  rm.registerConnection('s1', sender.send);

  rm.handleJoin('s1', 'session-F', 'sender', 0);
  assert.equal(rm.roomCount, 1);

  // A later join triggers the prune check (a real server would also run
  // this on an interval — see server.js).
  rm.handleJoin('s1', 'session-F', 'sender', 5000);

  assert.ok(sender.messages.some((m) => m.type === ServerMessageType.SESSION_EXPIRED));
});

test('a fully-paired room is never pruned just for being old', () => {
  const rm = new RoomManager({ ttlMs: 1000 });
  const sender = makeInbox();
  const receiver = makeInbox();
  rm.registerConnection('s1', sender.send);
  rm.registerConnection('r1', receiver.send);

  rm.handleJoin('s1', 'session-G', 'sender', 0);
  rm.handleJoin('r1', 'session-G', 'receiver', 500);
  rm._pruneExpired(999_999); // long after ttl

  assert.equal(rm.roomCount, 1);
});
