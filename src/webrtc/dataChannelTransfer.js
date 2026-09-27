// src/webrtc/dataChannelTransfer.js
//
// Drives the actual bytes across an already-open RTCDataChannel. Chunking
// and reassembly math live in src/transfer/chunking.js (unit tested); this
// module is the thin, RTCDataChannel-specific glue: it can't be unit
// tested without a browser, so keep it small and easy to read against the
// tested chunking module.

import {
  chunkBuffer,
  ChunkAssembler,
  computeProgress,
  formatTransferSpeed,
  estimateSecondsRemaining,
  DEFAULT_CHUNK_SIZE,
} from '../transfer/chunking.js';
import { DataChannelMessageType, buildFileMetadataMessage } from './protocol.js';

// How full the outgoing buffer is allowed to get before we pause sending
// and wait for the channel to drain. Keeps memory bounded on very large
// files and avoids overwhelming a slow link.
const BUFFERED_AMOUNT_HIGH_WATER_MARK = 4 * 1024 * 1024; // 4 MB
const BUFFERED_AMOUNT_LOW_WATER_MARK = 1 * 1024 * 1024; // 1 MB

function waitForDrain(dataChannel) {
  return new Promise((resolve) => {
    dataChannel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_WATER_MARK;
    const onLow = () => {
      dataChannel.removeEventListener('bufferedamountlow', onLow);
      resolve();
    };
    dataChannel.addEventListener('bufferedamountlow', onLow);
  });
}

/**
 * Sends a File/Blob over an open, binary-capable RTCDataChannel, honoring
 * backpressure. Begins the instant it's called — the whole point of the
 * GRAB interaction is that transfer does not wait for PUT.
 */
export class FileSender {
  /**
   * @param {RTCDataChannel} dataChannel
   * @param {File} file
   * @param {{chunkSize?: number, onProgress?: (p: {sentBytes:number,totalBytes:number,progress:number,speed:number}) => void}} options
   */
  constructor(dataChannel, file, { chunkSize = DEFAULT_CHUNK_SIZE, onProgress } = {}) {
    this.dataChannel = dataChannel;
    this.file = file;
    this.chunkSize = chunkSize;
    this.onProgress = onProgress || (() => {});
    this.fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._cancelled = false;
  }

  cancel() {
    this._cancelled = true;
    try {
      this.dataChannel.send(JSON.stringify({ type: DataChannelMessageType.TRANSFER_CANCELLED, fileId: this.fileId }));
    } catch {
      // channel may already be closed — nothing more to do
    }
  }

  /** Starts the transfer. Resolves once every chunk has been handed to the channel. */
  async send() {
    const buffer = await this.file.arrayBuffer();
    const frames = chunkBuffer(buffer, this.chunkSize);

    this.dataChannel.send(
      JSON.stringify(
        buildFileMetadataMessage(this.fileId, {
          name: this.file.name,
          size: this.file.size,
          mime: this.file.type || 'application/octet-stream',
          chunkSize: this.chunkSize,
          totalChunks: frames.length,
        })
      )
    );

    let sentBytes = 0;
    const startedAt = performance.now();
    const totalBytes = this.file.size;

    for (const frame of frames) {
      if (this._cancelled) return;

      if (this.dataChannel.bufferedAmount > BUFFERED_AMOUNT_HIGH_WATER_MARK) {
        await waitForDrain(this.dataChannel);
      }
      if (this._cancelled) return;

      this.dataChannel.send(frame);
      sentBytes += frame.byteLength;

      const elapsedSeconds = (performance.now() - startedAt) / 1000;
      const speed = elapsedSeconds > 0 ? sentBytes / elapsedSeconds : 0;
      this.onProgress({
        sentBytes,
        totalBytes,
        progress: computeProgress(sentBytes, totalBytes),
        speed,
        speedLabel: formatTransferSpeed(speed),
        etaSeconds: estimateSecondsRemaining(sentBytes, totalBytes, speed),
      });
    }

    if (!this._cancelled) {
      this.dataChannel.send(JSON.stringify({ type: DataChannelMessageType.TRANSFER_COMPLETE, fileId: this.fileId }));
    }
  }
}

/**
 * Receives control messages + binary chunks on an open data channel and
 * reassembles the file in the background, independent of when (or whether
 * yet) the local PUT gesture has fired.
 */
export class FileReceiver {
  /**
   * @param {RTCDataChannel} dataChannel
   * @param {{
   *   onMetadata?: (meta: {fileId:string,name:string,size:number,mime:string}) => void,
   *   onProgress?: (p: {receivedBytes:number,totalBytes:number,progress:number,speed:number}) => void,
   *   onComplete?: (file: {fileId:string,name:string,mime:string,blob:Blob}) => void,
   *   onCancelled?: (fileId: string) => void,
   * }} handlers
   */
  constructor(dataChannel, handlers = {}) {
    this.dataChannel = dataChannel;
    this.handlers = handlers;
    this.meta = null;
    this.assembler = null;
    this._receivedBytesAtLastTick = 0;
    this._lastTickAt = 0;

    dataChannel.binaryType = 'arraybuffer';
    dataChannel.addEventListener('message', (event) => this._onMessage(event));
  }

  _onMessage(event) {
    if (typeof event.data === 'string') {
      this._onControlMessage(JSON.parse(event.data));
      return;
    }
    this._onChunk(event.data);
  }

  _onControlMessage(message) {
    switch (message.type) {
      case DataChannelMessageType.FILE_METADATA: {
        this.meta = message;
        this.assembler = new ChunkAssembler(message.size, message.chunkSize);
        this._lastTickAt = performance.now();
        this._receivedBytesAtLastTick = 0;
        this.handlers.onMetadata?.(message);
        break;
      }
      case DataChannelMessageType.TRANSFER_CANCELLED: {
        this.handlers.onCancelled?.(message.fileId);
        this.meta = null;
        this.assembler = null;
        break;
      }
      case DataChannelMessageType.TRANSFER_COMPLETE: {
        // The binary chunks may still be arriving/queued; completion of
        // the *reveal* is driven by assembler.isComplete(), not by this
        // message alone, so we just no-op here and let _onChunk finish it.
        break;
      }
      default:
        break;
    }
  }

  _onChunk(frame) {
    if (!this.assembler) return; // chunk arrived before metadata — ignore defensively
    const { isComplete } = this.assembler.addChunk(frame);

    const now = performance.now();
    const elapsed = (now - this._lastTickAt) / 1000;
    if (elapsed > 0.2) {
      const deltaBytes = this.assembler.receivedBytes - this._receivedBytesAtLastTick;
      const speed = deltaBytes / elapsed;
      this.handlers.onProgress?.({
        receivedBytes: this.assembler.receivedBytes,
        totalBytes: this.assembler.totalBytes,
        progress: this.assembler.progress(),
        speed,
        speedLabel: formatTransferSpeed(speed),
      });
      this._lastTickAt = now;
      this._receivedBytesAtLastTick = this.assembler.receivedBytes;
    }

    if (isComplete) {
      const buffer = this.assembler.assemble();
      const blob = new Blob([buffer], { type: this.meta.mime });
      this.handlers.onComplete?.({
        fileId: this.meta.fileId,
        name: this.meta.name,
        mime: this.meta.mime,
        blob,
      });
    }
  }

  /** True once every chunk of the current file has arrived, whether or not PUT has fired yet. */
  isBuffered() {
    return !!this.assembler && this.assembler.isComplete();
  }
}
