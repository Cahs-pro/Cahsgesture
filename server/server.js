// server/server.js
//
// This is the "separate signaling service" the README talks about. It is
// NOT deployed to Vercel — Vercel's serverless functions don't hold a
// persistent WebSocket connection open, so a plain Node process (or any
// host that runs one for you — Render, Fly.io, Railway, a small VPS, etc.)
// is required here. See README → "Signaling architecture" for the exact
// deployment steps and why.
//
// All routing/pairing logic lives in roomManager.js and is unit tested
// there without needing a real socket. This file only:
//   1. accepts WebSocket connections,
//   2. assigns each one an id and a `send` function,
//   3. forwards JOIN / OFFER / ANSWER / ICE_CANDIDATE / PING messages into
//      the RoomManager,
//   4. cleans up on disconnect.

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { RoomManager } from './roomManager.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const PRUNE_INTERVAL_MS = 30_000;

// Hard caps so a misbehaving client can't grow memory unbounded — this
// server only ever needs to pass small JSON control messages.
const MAX_MESSAGE_BYTES = 64 * 1024;
const VALID_MESSAGE_TYPES = new Set(['JOIN', 'OFFER', 'ANSWER', 'ICE_CANDIDATE', 'PING']);
const VALID_ROLES = new Set(['sender', 'receiver']);

const rooms = new RoomManager();
const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (socket) => {
  const connId = randomUUID();
  rooms.registerConnection(connId, (message) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  });

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames rather than crashing the room
    }

    if (!message || typeof message.type !== 'string' || !VALID_MESSAGE_TYPES.has(message.type)) {
      return;
    }

    switch (message.type) {
      case 'JOIN': {
        const { sessionId, role } = message;
        if (typeof sessionId !== 'string' || !sessionId || !VALID_ROLES.has(role)) return;
        rooms.handleJoin(connId, sessionId, role);
        break;
      }
      case 'PING':
        socket.send(JSON.stringify({ type: 'PONG' }));
        break;
      case 'OFFER':
      case 'ANSWER':
      case 'ICE_CANDIDATE':
        // Routed verbatim — the server never inspects SDP/ICE contents.
        rooms.relay(connId, message);
        break;
      default:
        break;
    }
  });

  socket.on('close', () => rooms.handleLeave(connId));
  socket.on('error', () => rooms.handleLeave(connId));
});

// Unclaimed sessions (sender created a room, no receiver ever scanned it)
// are also pruned lazily on the next JOIN, but a periodic sweep means a
// sender who just leaves their tab open still gets notified.
setInterval(() => rooms._pruneExpired(Date.now()), PRUNE_INTERVAL_MS).unref();

console.log(`GestureShare signaling server listening on ws://localhost:${PORT}`);
