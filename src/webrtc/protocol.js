// src/webrtc/protocol.js
//
// Two separate channels carry messages in this app, and it's important to
// keep them straight:
//
//  1. The SIGNALING channel (WebSocket, see pairing/signalingClient.js)
//     carries only session/offer/answer/ICE control messages. It NEVER
//     sees file bytes.
//
//  2. The WebRTC DATA CHANNEL carries the GRAB_START / FILE_METADATA /
//     PUT_DETECTED control messages (as small JSON text frames) interleaved
//     with the binary file chunks. This is what makes "background transfer
//     starts the instant GRAB fires" possible without a server round-trip.

export const SignalingMessageType = Object.freeze({
  JOIN: 'JOIN', // receiver -> server: "I'm scanning session X"
  PEER_JOINED: 'PEER_JOINED', // server -> sender: a receiver joined
  OFFER: 'OFFER',
  ANSWER: 'ANSWER',
  ICE_CANDIDATE: 'ICE_CANDIDATE',
  PEER_LEFT: 'PEER_LEFT',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_FULL: 'SESSION_FULL',
  ERROR: 'ERROR',
});

// Data-channel control messages are sent as JSON text frames. Binary frames
// (ArrayBuffer) are always file chunks and are never ambiguous with these,
// since RTCDataChannel delivers text and binary as distinct message types.
export const DataChannelMessageType = Object.freeze({
  GRAB_START: 'GRAB_START',
  FILE_METADATA: 'FILE_METADATA',
  TRANSFER_COMPLETE: 'TRANSFER_COMPLETE',
  TRANSFER_CANCELLED: 'TRANSFER_CANCELLED',
  PUT_DETECTED: 'PUT_DETECTED',
  PING: 'PING',
  PONG: 'PONG',
});

/**
 * @param {string} fileId
 * @param {{name:string, size:number, mime:string, chunkSize:number, totalChunks:number}} file
 */
export function buildGrabStartMessage(fileId, file) {
  return {
    type: DataChannelMessageType.GRAB_START,
    fileId,
    name: file.name,
    size: file.size,
    mime: file.mime,
  };
}

export function buildFileMetadataMessage(fileId, file) {
  return {
    type: DataChannelMessageType.FILE_METADATA,
    fileId,
    name: file.name,
    size: file.size,
    mime: file.mime,
    chunkSize: file.chunkSize,
    totalChunks: file.totalChunks,
  };
}
