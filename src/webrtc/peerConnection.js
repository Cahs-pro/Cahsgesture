// src/webrtc/peerConnection.js
//
// Real RTCPeerConnection/RTCDataChannel setup. Cannot be unit tested
// without a browser WebRTC stack; kept intentionally thin so the only
// "logic" living here is wiring, not anything that needs its own tests.
//
// One deliberate exception: the "disconnected is not the same as failed"
// debounce below. WebRTC's connectionState routinely flips to
// 'disconnected' for a few seconds under real network conditions — a
// brief Wi-Fi hiccup, or simply a burst of load like a data-channel
// transfer starting — and then recovers to 'connected' on its own. Only
// 'failed' means the connection is actually dead. Reporting a bare
// 'disconnected' as fatal (and tearing the whole session down for it)
// is a common WebRTC mistake that looks exactly like "the app randomly
// drops the connection right when a transfer starts."

const DISCONNECT_GRACE_MS = 6000;

// Public STUN-only configuration. STUN is enough to establish a direct
// connection on most home/mobile networks. It is NOT enough on networks
// with symmetric NAT or restrictive firewalls — those require a TURN
// relay, which this project does not bundle (see README "Known
// limitations"). Add your own TURN server here if you need one:
//
//   { urls: 'turn:your-turn-host:3478', username: '...', credential: '...' }
//
export const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

export const ConnectionState = Object.freeze({
  NEW: 'new',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  FAILED: 'failed',
  CLOSED: 'closed',
});

/**
 * Wraps an RTCPeerConnection with the handful of events GestureShare cares
 * about, and forwards signaling traffic through the provided signaling
 * client rather than assuming any particular signaling transport.
 */
export class GesturePeerConnection {
  constructor({ signaling, iceServers = DEFAULT_ICE_SERVERS, onConnectionStateChange, onDataChannel }) {
    this.signaling = signaling;
    this.pc = new RTCPeerConnection({ iceServers });
    this.dataChannel = null;
    this._onDataChannel = onDataChannel || (() => {});
    this._notifyStateChange = onConnectionStateChange || (() => {});
    this._disconnectTimer = null;

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(event.candidate.toJSON());
      }
    });

    this.pc.addEventListener('connectionstatechange', () => {
      const state = this.pc.connectionState;

      if (state === 'connected') {
        this._clearDisconnectTimer();
        this._notifyStateChange('connected');
        return;
      }

      if (state === 'disconnected') {
        if (!this._disconnectTimer) {
          this._disconnectTimer = setTimeout(() => {
            this._disconnectTimer = null;
            if (this.pc.connectionState !== 'connected') {
              this._notifyStateChange('failed');
            }
          }, DISCONNECT_GRACE_MS);
        }
        return;
      }

      if (state === 'failed' || state === 'closed') {
        this._clearDisconnectTimer();
        this._notifyStateChange(state);
        return;
      }
    });

    this.pc.addEventListener('datachannel', (event) => {
      this.dataChannel = event.channel;
      this._onDataChannel(event.channel);
    });
  }

  _clearDisconnectTimer() {
    if (this._disconnectTimer) {
      clearTimeout(this._disconnectTimer);
      this._disconnectTimer = null;
    }
  }

  async createOfferAsSender() {
    this.dataChannel = this.pc.createDataChannel('gestureshare', { ordered: true });
    this._onDataChannel(this.dataChannel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  async createAnswerFromOffer(offer) {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  async applyAnswer(answer) {
    await this.pc.setRemoteDescription(answer);
  }

  async addIceCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Failed to add ICE candidate', err);
    }
  }

  close() {
    this._clearDisconnectTimer();
    try {
      this.dataChannel?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }
}
