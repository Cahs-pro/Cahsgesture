// src/pairing/signalingClient.js
//
// Thin WebSocket client for the signaling server in /server. Carries only
// pairing/offer/answer/ICE/control messages — see webrtc/protocol.js for
// why file bytes never touch this channel.

import { SignalingMessageType } from '../webrtc/protocol.js';

const HEARTBEAT_INTERVAL_MS = 15_000;
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 3;

export class SignalingClient {
  /**
   * @param {string} url e.g. wss://your-signaling-host
   * @param {string} sessionId
   * @param {'sender'|'receiver'} role
   */
  constructor(url, sessionId, role) {
    this.url = url;
    this.sessionId = sessionId;
    this.role = role;
    this.ws = null;
    this._listeners = new Map();
    this._heartbeatTimer = null;
    this._reconnectAttempts = 0;
    this._closedByUser = false;
  }

  on(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
    return this;
  }

  _emit(type, payload) {
    for (const handler of this._listeners.get(type) || []) handler(payload);
  }

  connect() {
    this._closedByUser = false;
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener('open', () => {
      this._reconnectAttempts = 0;
      this._send({ type: SignalingMessageType.JOIN, sessionId: this.sessionId, role: this.role });
      this._startHeartbeat();
      this._emit('open');
    });

    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return; // ignore malformed frames rather than crashing the app
      }
      this._emit(message.type, message);
      this._emit('message', message);
    });

    this.ws.addEventListener('close', () => {
      this._stopHeartbeat();
      this._emit('close');
      if (!this._closedByUser && this._reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this._reconnectAttempts += 1;
        setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      } else if (!this._closedByUser) {
        this._emit('reconnectFailed');
      }
    });

    this.ws.addEventListener('error', (err) => {
      this._emit('error', err);
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this._send({ type: 'PING' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  _send(payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendOffer(offer) {
    this._send({ type: SignalingMessageType.OFFER, sessionId: this.sessionId, sdp: offer });
  }

  sendAnswer(answer) {
    this._send({ type: SignalingMessageType.ANSWER, sessionId: this.sessionId, sdp: answer });
  }

  sendIceCandidate(candidate) {
    this._send({ type: SignalingMessageType.ICE_CANDIDATE, sessionId: this.sessionId, candidate });
  }

  close() {
    this._closedByUser = true;
    this._stopHeartbeat();
    this.ws?.close();
  }
}
