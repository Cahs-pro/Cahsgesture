// server/roomManager.js
//
// All the actual "who talks to whom" logic for the signaling server, kept
// free of any dependency on the `ws` library (or any transport at all) so
// it can be unit tested with plain mock connections. server.js is the thin
// adapter that wires real WebSocket connections into this class.
//
// A "room" is nothing more than the pairing session id the sender put in
// its QR code. There is no database — rooms live in memory only and are
// deleted the moment they're no longer needed (a peer leaves, or they
// expire unclaimed).

export const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes, matches pairing/session.js

export const ServerMessageType = Object.freeze({
  PEER_JOINED: 'PEER_JOINED',
  PEER_LEFT: 'PEER_LEFT',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_FULL: 'SESSION_FULL',
  ERROR: 'ERROR',
});

export class RoomManager {
  constructor({ ttlMs = SESSION_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.rooms = new Map(); // sessionId -> { sender, receiver, expiresAt }
    this.connections = new Map(); // connId -> { send, sessionId, role }
  }

  /**
   * @param {string} connId unique id for this socket (assigned by the transport adapter)
   * @param {(message: object) => void} send
   */
  registerConnection(connId, send) {
    this.connections.set(connId, { send, sessionId: null, role: null });
  }

  /**
   * @param {string} connId
   * @param {string} sessionId
   * @param {'sender'|'receiver'} role
   * @param {number} now epoch ms, injectable for tests
   */
  handleJoin(connId, sessionId, role, now = Date.now()) {
    const conn = this.connections.get(connId);
    if (!conn) return;

    this._pruneExpired(now);

    let room = this.rooms.get(sessionId);

    if (role === 'sender') {
      if (!room) {
        room = { sender: null, receiver: null, expiresAt: now + this.ttlMs };
        this.rooms.set(sessionId, room);
      }
      if (room.sender && room.sender !== connId) {
        conn.send({ type: ServerMessageType.SESSION_FULL });
        return;
      }
      room.sender = connId;
    } else {
      if (!room) {
        conn.send({ type: ServerMessageType.SESSION_EXPIRED });
        return;
      }
      if (room.receiver && room.receiver !== connId) {
        conn.send({ type: ServerMessageType.SESSION_FULL });
        return;
      }
      room.receiver = connId;
    }

    conn.sessionId = sessionId;
    conn.role = role;

    if (room.sender && room.receiver) {
      const senderConn = this.connections.get(room.sender);
      const receiverConn = this.connections.get(room.receiver);
      // Only the sender needs to know a receiver showed up — it's the one
      // that creates the WebRTC offer.
      if (role === 'receiver') senderConn?.send({ type: ServerMessageType.PEER_JOINED });
      void receiverConn;
    }
  }

  /**
   * Relays an OFFER / ANSWER / ICE_CANDIDATE message verbatim to the other
   * participant in the sender's room. The signaling server never inspects
   * or modifies SDP/ICE payloads beyond routing them.
   * @param {string} connId
   * @param {object} message must already have a `type`
   */
  relay(connId, message) {
    const conn = this.connections.get(connId);
    if (!conn || !conn.sessionId) return;
    const room = this.rooms.get(conn.sessionId);
    if (!room) return;

    const peerId = conn.role === 'sender' ? room.receiver : room.sender;
    const peerConn = peerId && this.connections.get(peerId);
    peerConn?.send(message);
  }

  handleLeave(connId) {
    const conn = this.connections.get(connId);
    if (!conn) return;

    if (conn.sessionId) {
      const room = this.rooms.get(conn.sessionId);
      if (room) {
        const peerId = conn.role === 'sender' ? room.receiver : room.sender;
        const peerConn = peerId && this.connections.get(peerId);
        peerConn?.send({ type: ServerMessageType.PEER_LEFT });
        // Two-participant rooms: once either side leaves, the room is done.
        this.rooms.delete(conn.sessionId);
      }
    }

    this.connections.delete(connId);
  }

  _pruneExpired(now) {
    for (const [sessionId, room] of this.rooms) {
      const isUnclaimed = !(room.sender && room.receiver);
      if (isUnclaimed && now >= room.expiresAt) {
        const staleConn = room.sender && this.connections.get(room.sender);
        staleConn?.send({ type: ServerMessageType.SESSION_EXPIRED });
        this.rooms.delete(sessionId);
      }
    }
  }

  /** For tests / metrics. */
  get roomCount() {
    return this.rooms.size;
  }
}
