// src/transfer/chunking.js
//
// Pure, environment-agnostic chunking + reassembly logic for sending a file
// over an RTCDataChannel. No DOM, no WebRTC objects — this module only deals
// in ArrayBuffer/Uint8Array so it can be unit tested with plain Node.
//
// Wire format for each binary chunk sent over the data channel:
//
//   [ 4 bytes: chunk index, uint32 little-endian ]
//   [ N bytes: raw chunk payload ]
//
// The index is redundant with RTCDataChannel's ordered+reliable delivery,
// but keeping it explicit lets the receiver verify nothing was skipped or
// duplicated instead of silently trusting delivery order, and makes the
// format testable without a real data channel.

export const DEFAULT_CHUNK_SIZE = 32 * 1024; // 32 KB — inside the 16-64KB target range
export const CHUNK_HEADER_BYTES = 4;

/**
 * Split an ArrayBuffer into an ordered list of framed chunks ready to hand
 * to `dataChannel.send()`.
 * @param {ArrayBuffer} buffer
 * @param {number} chunkSize
 * @returns {ArrayBuffer[]} framed chunks (header + payload)
 */
export function chunkBuffer(buffer, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new TypeError('chunkBuffer expects an ArrayBuffer');
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= CHUNK_HEADER_BYTES) {
    throw new RangeError('chunkSize must be an integer greater than the header size');
  }

  const totalBytes = buffer.byteLength;
  const payloadCapacity = chunkSize - CHUNK_HEADER_BYTES;
  const totalChunks = totalBytes === 0 ? 1 : Math.ceil(totalBytes / payloadCapacity);
  const source = new Uint8Array(buffer);
  const frames = [];

  for (let index = 0; index < totalChunks; index++) {
    const start = index * payloadCapacity;
    const end = Math.min(start + payloadCapacity, totalBytes);
    const payload = source.subarray(start, end);

    const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.length);
    new DataView(frame.buffer).setUint32(0, index, true);
    frame.set(payload, CHUNK_HEADER_BYTES);
    frames.push(frame.buffer);
  }

  return frames;
}

/**
 * Incrementally reassembles framed chunks back into the original bytes.
 * Designed to be fed one ArrayBuffer at a time as they arrive over the
 * data channel, in whatever order they arrive (ordered channels will
 * deliver in order, but this does not assume that).
 */
export class ChunkAssembler {
  /**
   * @param {number} totalBytes total size of the original file, from metadata
   * @param {number} chunkSize the chunk size used by the sender
   */
  constructor(totalBytes, chunkSize = DEFAULT_CHUNK_SIZE) {
    if (!Number.isInteger(totalBytes) || totalBytes < 0) {
      throw new RangeError('totalBytes must be a non-negative integer');
    }
    this.totalBytes = totalBytes;
    this.chunkSize = chunkSize;
    this.payloadCapacity = chunkSize - CHUNK_HEADER_BYTES;
    this.totalChunks = totalBytes === 0 ? 1 : Math.ceil(totalBytes / this.payloadCapacity);
    this.received = new Map(); // index -> Uint8Array payload
    this.receivedBytes = 0;
  }

  /**
   * @param {ArrayBuffer} frame a single framed chunk as produced by chunkBuffer
   * @returns {{index: number, isDuplicate: boolean, isComplete: boolean}}
   */
  addChunk(frame) {
    if (!(frame instanceof ArrayBuffer)) {
      throw new TypeError('addChunk expects an ArrayBuffer');
    }
    if (frame.byteLength < CHUNK_HEADER_BYTES) {
      throw new RangeError('frame is smaller than the chunk header');
    }
    const index = new DataView(frame).getUint32(0, true);
    if (index < 0 || index >= this.totalChunks) {
      throw new RangeError(`chunk index ${index} out of range (expected 0..${this.totalChunks - 1})`);
    }
    const payload = new Uint8Array(frame, CHUNK_HEADER_BYTES);
    const isDuplicate = this.received.has(index);

    if (!isDuplicate) {
      this.received.set(index, payload);
      this.receivedBytes += payload.length;
    }

    return { index, isDuplicate, isComplete: this.isComplete() };
  }

  isComplete() {
    return this.received.size === this.totalChunks;
  }

  progress() {
    return computeProgress(this.receivedBytes, this.totalBytes);
  }

  /**
   * Concatenate all received chunks, in index order, into a single buffer.
   * Throws if the transfer is not complete yet.
   * @returns {ArrayBuffer}
   */
  assemble() {
    if (!this.isComplete()) {
      throw new Error(
        `cannot assemble: received ${this.received.size}/${this.totalChunks} chunks`
      );
    }
    const out = new Uint8Array(this.totalBytes);
    let offset = 0;
    for (let index = 0; index < this.totalChunks; index++) {
      const payload = this.received.get(index);
      out.set(payload, offset);
      offset += payload.length;
    }
    return out.buffer;
  }
}

/**
 * @param {number} receivedBytes
 * @param {number} totalBytes
 * @returns {number} 0..1, or 1 when totalBytes is 0 (nothing to transfer)
 */
export function computeProgress(receivedBytes, totalBytes) {
  if (totalBytes <= 0) return 1;
  return Math.max(0, Math.min(1, receivedBytes / totalBytes));
}

/**
 * Formats bytes/sec into a short human string, e.g. "1.9 MB/s".
 * @param {number} bytesPerSecond
 */
export function formatTransferSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '0 KB/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Estimates seconds remaining from current progress and measured speed.
 * @returns {number} seconds, or Infinity if speed is 0 and not complete
 */
export function estimateSecondsRemaining(receivedBytes, totalBytes, bytesPerSecond) {
  const remaining = Math.max(0, totalBytes - receivedBytes);
  if (remaining === 0) return 0;
  if (!bytesPerSecond || bytesPerSecond <= 0) return Infinity;
  return remaining / bytesPerSecond;
}
