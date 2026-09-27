// src/webrtc/peerConnection.js
//
// Real RTCPeerConnection/RTCDataChannel setup. Cannot be unit tested
// without a browser WebRTC stack; kept intentionally thin so the only
// "logic" living here is wiring, not anything that needs its own tests.

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
  /**
   * @param {{
   *   signaling: import('../pairing/signalingClient.js').SignalingClient,
   *   iceServers?: RTCIceServer[],
   *   onConnectionStateChange?: (state: string) => void,
   *   onDataChannel?: (channel: RTCDataChannel) => void,
   * }} options
   */
  constructor({ signaling, iceServers = DEFAULT_ICE_SERVERS, onConnectionStateChange, onDataChannel }) {
    this.signaling = signaling;
    this.pc = new RTCPeerConnection({ iceServers });
    this.dataChannel = null;
    this._onDataChannel = onDataChannel || (() => {});

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(event.candidate.toJSON());
      }
    });

    this.pc.addEventListener('connectionstatechange', () => {
      onConnectionStateChange?.(this.pc.connectionState);
    });

    this.pc.addEventListener('datachannel', (event) => {
      this.dataChannel = event.channel;
      this._onDataChannel(event.channel);
    });
  }

  /** Sender side: creates the data channel and an SDP offer. */
  async createOfferAsSender() {
    this.dataChannel = this.pc.createDataChannel('gestureshare', { ordered: true });
    this._onDataChannel(this.dataChannel);

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /** Receiver side: applies the sender's offer and creates an SDP answer. */
  async createAnswerFromOffer(offer) {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /** Sender side: applies the receiver's answer once it arrives via signaling. */
  async applyAnswer(answer) {
    await this.pc.setRemoteDescription(answer);
  }

  /** Both sides: queue a remote ICE candidate as it arrives via signaling. */
  async addIceCandidate(candidate) {
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // Late/duplicate candidates are common and harmless — surface
      // anything else as a console warning rather than crashing the flow.
      console.warn('Failed to add ICE candidate', err);
    }
  }

  close() {
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
