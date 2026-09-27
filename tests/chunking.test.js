import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chunkBuffer,
  ChunkAssembler,
  computeProgress,
  formatTransferSpeed,
  estimateSecondsRemaining,
  CHUNK_HEADER_BYTES,
} from '../src/transfer/chunking.js';

function makeBuffer(size, fill = (i) => i % 256) {
  const arr = new Uint8Array(size);
  for (let i = 0; i < size; i++) arr[i] = fill(i);
  return arr.buffer;
}

test('chunkBuffer + ChunkAssembler round-trip reproduces the original bytes', () => {
  const original = makeBuffer(200_000);
  const chunkSize = 4096;
  const frames = chunkBuffer(original, chunkSize);

  const assembler = new ChunkAssembler(original.byteLength, chunkSize);
  for (const frame of frames) {
    assembler.addChunk(frame);
  }

  assert.equal(assembler.isComplete(), true);
  const result = assembler.assemble();
  assert.deepEqual(new Uint8Array(result), new Uint8Array(original));
});

test('assembler handles out-of-order delivery', () => {
  const original = makeBuffer(50_000, (i) => (i * 7) % 256);
  const chunkSize = 2048;
  const frames = chunkBuffer(original, chunkSize);

  const shuffled = [...frames].reverse();
  const assembler = new ChunkAssembler(original.byteLength, chunkSize);
  for (const frame of shuffled) assembler.addChunk(frame);

  assert.equal(assembler.isComplete(), true);
  assert.deepEqual(new Uint8Array(assembler.assemble()), new Uint8Array(original));
});

test('assembler ignores duplicate chunks without corrupting the result', () => {
  const original = makeBuffer(10_000);
  const chunkSize = 1024;
  const frames = chunkBuffer(original, chunkSize);

  const assembler = new ChunkAssembler(original.byteLength, chunkSize);
  for (const frame of frames) {
    const first = assembler.addChunk(frame);
    const second = assembler.addChunk(frame); // resend the same chunk
    assert.equal(first.isDuplicate, false);
    assert.equal(second.isDuplicate, true);
  }

  assert.equal(assembler.receivedBytes, original.byteLength);
  assert.deepEqual(new Uint8Array(assembler.assemble()), new Uint8Array(original));
});

test('assembler rejects an out-of-range chunk index', () => {
  const assembler = new ChunkAssembler(1000, 512);
  const bogusFrame = new ArrayBuffer(CHUNK_HEADER_BYTES + 4);
  new DataView(bogusFrame).setUint32(0, 999, true); // way past totalChunks
  assert.throws(() => assembler.addChunk(bogusFrame), RangeError);
});

test('assemble() throws before the transfer is complete', () => {
  const original = makeBuffer(5000);
  const frames = chunkBuffer(original, 1024);
  const assembler = new ChunkAssembler(original.byteLength, 1024);
  assembler.addChunk(frames[0]);
  assert.throws(() => assembler.assemble(), /cannot assemble/);
});

test('computeProgress clamps to 0..1 and handles a zero-byte file', () => {
  assert.equal(computeProgress(0, 100), 0);
  assert.equal(computeProgress(50, 100), 0.5);
  assert.equal(computeProgress(150, 100), 1); // never overshoot
  assert.equal(computeProgress(0, 0), 1); // nothing to send == already done
});

test('formatTransferSpeed produces readable units', () => {
  assert.equal(formatTransferSpeed(0), '0 B/s');
  assert.equal(formatTransferSpeed(500), '500 B/s');
  assert.equal(formatTransferSpeed(2_000_000), '1.9 MB/s');
});

test('estimateSecondsRemaining', () => {
  assert.equal(estimateSecondsRemaining(100, 100, 500), 0);
  assert.equal(estimateSecondsRemaining(0, 1000, 1000), 1);
  assert.equal(estimateSecondsRemaining(0, 1000, 0), Infinity);
});
