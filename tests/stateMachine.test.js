import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSenderMachine,
  createReceiverMachine,
  SENDER_STATES,
  RECEIVER_STATES,
} from '../src/app/stateMachine.js';

test('sender happy path follows the exact documented sequence', () => {
  const sender = createSenderMachine();
  assert.equal(sender.state, SENDER_STATES.IDLE);

  assert.equal(sender.send('PAIRED'), SENDER_STATES.PAIRED);
  assert.equal(sender.send('FILE_SELECTED'), SENDER_STATES.FILE_SELECTED);
  assert.equal(sender.send('READY'), SENDER_STATES.WAITING_FOR_GRAB);
  assert.equal(sender.send('GRAB_DETECTED'), SENDER_STATES.GRABBED);
  assert.equal(sender.send('TRANSFER_STARTED'), SENDER_STATES.TRANSFERRING);
  assert.equal(sender.send('TRANSFER_COMPLETE'), SENDER_STATES.WAITING_FOR_PUT_CONFIRMATION);
  assert.equal(sender.send('PUT_DETECTED'), SENDER_STATES.COMPLETE);
});

test('receiver happy path automatically opens PUT_SCREEN on GRAB_START', () => {
  const receiver = createReceiverMachine();
  receiver.send('PAIRED');
  receiver.send('SESSION_READY');
  assert.equal(receiver.state, RECEIVER_STATES.WAITING_FOR_GRAB);

  // This is the critical automatic transition: no user action here.
  assert.equal(receiver.send('GRAB_START'), RECEIVER_STATES.PUT_SCREEN);
  assert.equal(receiver.send('TRANSFER_STARTED'), RECEIVER_STATES.BUFFERING);
  assert.equal(receiver.send('PUT_GESTURE_DETECTED'), RECEIVER_STATES.PUT_DETECTED);
  assert.equal(receiver.send('DATA_READY'), RECEIVER_STATES.REVEAL);
  assert.equal(receiver.send('ACKNOWLEDGED'), RECEIVER_STATES.COMPLETE);
});

test('invalid transitions are rejected and do not move the state', () => {
  const sender = createSenderMachine();
  // Cannot GRAB before pairing/selecting a file at all.
  const result = sender.send('GRAB_DETECTED');
  assert.equal(result, false);
  assert.equal(sender.state, SENDER_STATES.IDLE);
});

test('receiver cannot skip straight to REVEAL without a PUT gesture', () => {
  const receiver = createReceiverMachine();
  receiver.send('PAIRED');
  receiver.send('SESSION_READY');
  receiver.send('GRAB_START');
  receiver.send('TRANSFER_STARTED');
  // Skipping PUT_GESTURE_DETECTED:
  const result = receiver.send('DATA_READY');
  assert.equal(result, false);
  assert.equal(receiver.state, RECEIVER_STATES.BUFFERING);
});

test('ERROR is reachable from any state and PAIRED recovers from it', () => {
  const sender = createSenderMachine();
  sender.send('PAIRED');
  sender.send('FILE_SELECTED');
  assert.equal(sender.send('ERROR'), SENDER_STATES.ERROR);
  assert.equal(sender.send('PAIRED'), SENDER_STATES.PAIRED);
});

test('transition and reject listeners fire correctly', () => {
  const sender = createSenderMachine();
  const seen = [];
  sender.on('transition', (t) => seen.push(t));
  const rejected = [];
  sender.on('reject', (r) => rejected.push(r));

  sender.send('PAIRED');
  sender.send('GRAB_DETECTED'); // illegal from PAIRED

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { from: 'IDLE', to: 'PAIRED', event: 'PAIRED', meta: undefined });
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].event, 'GRAB_DETECTED');
});

test('a completed sender can select another file and go again', () => {
  const sender = createSenderMachine();
  for (const e of ['PAIRED', 'FILE_SELECTED', 'READY', 'GRAB_DETECTED', 'TRANSFER_STARTED', 'TRANSFER_COMPLETE', 'PUT_DETECTED']) {
    sender.send(e);
  }
  assert.equal(sender.state, SENDER_STATES.COMPLETE);
  assert.equal(sender.send('FILE_SELECTED'), SENDER_STATES.FILE_SELECTED);
});
