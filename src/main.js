// src/main.js
//
// Orchestrates every module into the actual GRAB -> MOVE -> PUT flow. This
// file intentionally contains no gesture math, no chunking math, and no
// state-transition rules of its own — those live in their own tested
// modules. This file's only job is wiring: DOM events -> module calls,
// module callbacks -> state machine events -> screen updates.

import { getSignalingUrl, isDebugMode } from './config.js';
import { createSenderMachine, createReceiverMachine } from './app/stateMachine.js';
import { requestCamera, stopCameraStream, CameraError } from './camera/camera.js';
import { createHandLandmarker, HandTrackingLoop } from './gestures/handLandmarker.js';
import { GestureStateTracker } from './gestures/gestureClassifier.js';
import { GesturePeerConnection } from './webrtc/peerConnection.js';
import { SignalingClient } from './pairing/signalingClient.js';
import { SignalingMessageType, DataChannelMessageType } from './webrtc/protocol.js';
import { FileSender, FileReceiver } from './webrtc/dataChannelTransfer.js';
import { createSession, buildPairingUrl, parseSessionFromUrl } from './pairing/session.js';
import { renderPairingQr, scanQrFromVideo } from './pairing/qr.js';
import { sanitizeFilename, formatFileSize } from './utils/sanitize.js';
import {
  initScreens,
  showScreen,
  setStatusText,
  setFileInfo,
  setImagePreview,
  setProgressBar,
  setGestureStatus,
  updateDebugPanel,
  revokeIfSet,
} from './ui/screens.js';

const dom = {
  screens: null,
  qrCanvas: document.getElementById('qr-canvas'),
  scanVideo: document.getElementById('scan-video'),
  senderVideo: document.getElementById('sender-video'),
  receiverVideo: document.getElementById('receiver-video'),
  senderImage: document.getElementById('sender-image'),
  grabbedImage: document.getElementById('grabbed-image'),
  revealImage: document.getElementById('reveal-image'),
  fileInput: document.getElementById('file-input'),
  senderFileName: document.getElementById('sender-file-name'),
  senderFileSize: document.getElementById('sender-file-size'),
  revealFileName: document.getElementById('reveal-file-name'),
  revealFileMeta: document.getElementById('reveal-file-meta'),
  senderGestureStatus: document.getElementById('sender-gesture-status'),
  receiverGestureStatus: document.getElementById('receiver-gesture-status'),
  transferBar: document.getElementById('transfer-bar'),
  transferLabel: document.getElementById('transfer-label'),
  receiverTransferBar: document.getElementById('receiver-transfer-bar'),
  receiverTransferLabel: document.getElementById('receiver-transfer-label'),
  connectionStatus: document.getElementById('connection-status'),
  errorMessage: document.getElementById('error-message'),
  errorRetry: document.getElementById('error-retry'),
  debugPanel: document.getElementById('debug-panel'),
  pairDeviceBtn: document.getElementById('pair-device-btn'),
  scanQrBtn: document.getElementById('scan-qr-btn'),
  cancelSenderBtn: document.getElementById('cancel-sender-btn'),
  saveReceivedBtn: document.getElementById('save-received-btn'),
  doneBtn: document.getElementById('done-btn'),
};

/** Central place for everything that must be torn down between attempts / on error. */
const resources = {
  cameraStream: null,
  trackingLoop: null,
  handLandmarker: null,
  peer: null,
  signaling: null,
  fileSender: null,
  fileReceiver: null,
  currentImageUrl: null,
  cancelQrScan: null,
};

function cleanupAll() {
  resources.trackingLoop?.stop();
  resources.handLandmarker?.close();
  stopCameraStream(resources.cameraStream);
  resources.peer?.close();
  resources.signaling?.close();
  resources.cancelQrScan?.();
  revokeIfSet(resources.currentImageUrl);
  resources.cameraStream = null;
  resources.trackingLoop = null;
  resources.handLandmarker = null;
  resources.peer = null;
  resources.signaling = null;
  resources.fileSender = null;
  resources.fileReceiver = null;
  resources.currentImageUrl = null;
  resources.cancelQrScan = null;
}

function showError(message, { retryable = true } = {}) {
  cleanupAll();
  setStatusText(dom.errorMessage, message);
  dom.errorRetry.style.display = retryable ? '' : 'none';
  showScreen(dom.screens, 'error');
}

// ---------------------------------------------------------------------------
// Shared: gesture tracking loop (used by both the sender's GRAB detection
// and the receiver's PUT detection — same classifier, different meaning).
// ---------------------------------------------------------------------------

async function startGestureLoop(videoEl, onEvent, onFrame, trackerConfig = {}) {
  const stream = await requestCamera({ facingMode: 'user' });
  resources.cameraStream = stream;
  videoEl.srcObject = stream;
  await videoEl.play();

  const landmarker = await createHandLandmarker({ numHands: 1 });
  resources.handLandmarker = landmarker;

  const tracker = new GestureStateTracker();
  const loop = new HandTrackingLoop(videoEl, landmarker, tracker, (frame) => {
    onFrame?.(frame);
    if (frame.event) onEvent(frame.event);
  });
  resources.trackingLoop = loop;
  loop.start();
  return { tracker, loop };
}

// ---------------------------------------------------------------------------
// Pairing + WebRTC bootstrap, shared shape for both roles.
// ---------------------------------------------------------------------------

function connectSignaling(sessionId, role) {
  const signaling = new SignalingClient(getSignalingUrl(), sessionId, role);
  resources.signaling = signaling;
  signaling.on('error', () => {
    showError('Could not connect to the signaling service. Check your connection and try again.');
  });
  signaling.on(SignalingMessageType.SESSION_EXPIRED, () => {
    showError('This pairing session expired. Start again from the welcome screen.');
  });
  signaling.on(SignalingMessageType.SESSION_FULL, () => {
    showError('That session is already paired with another device.');
  });
  signaling.on('reconnectFailed', () => {
    showError('Lost connection to the signaling service.');
  });
  signaling.connect();
  return signaling;
}

function debugSnapshot(extra) {
  return {
    role: extra.role,
    appState: extra.appState,
    ice: resources.peer?.pc.iceConnectionState,
    connection: resources.peer?.pc.connectionState,
    dataChannel: resources.peer?.dataChannel?.readyState,
    ...extra.gesture,
  };
}

// ---------------------------------------------------------------------------
// SENDER
// ---------------------------------------------------------------------------

async function runSenderFlow() {
  const sender = createSenderMachine();
  const session = createSession();
  const pairingUrl = buildPairingUrl(window.location.origin, session.id);

  showScreen(dom.screens, 'qr-pairing');
  await renderPairingQr(dom.qrCanvas, pairingUrl);
  setStatusText(dom.connectionStatus, 'Waiting for the other device to scan…');

  const signaling = connectSignaling(session.id, 'sender');

  signaling.on(SignalingMessageType.PEER_JOINED, async () => {
    setStatusText(dom.connectionStatus, 'Device found — negotiating connection…');
    const peer = new GesturePeerConnection({
      signaling,
      onConnectionStateChange: (state) => {
        if (state === 'connected') {
          setStatusText(dom.connectionStatus, 'Secure channel established');
          sender.send('PAIRED');
          showScreen(dom.screens, 'sender-select');
        } else if (state === 'failed' || state === 'disconnected') {
          showError('The other device disconnected.');
        }
      },
    });
    resources.peer = peer;

    signaling.on(SignalingMessageType.ANSWER, (msg) => peer.applyAnswer(msg.sdp));
    signaling.on(SignalingMessageType.ICE_CANDIDATE, (msg) => peer.addIceCandidate(msg.candidate));
    // A dropped peer mid-session should not strand the UI on a dead screen.
    signaling.on(SignalingMessageType.PEER_LEFT, () => showError('The other device disconnected.'));

    const offer = await peer.createOfferAsSender();
    signaling.sendOffer(offer);

    // The sender also needs to *receive* the PUT_DETECTED confirmation that
    // travels back over this same data channel.
    peer.dataChannel.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data);
      if (message.type === DataChannelMessageType.PUT_DETECTED) {
        sender.send('PUT_DETECTED');
        showScreen(dom.screens, 'sender-select'); // ready to send again
        setStatusText(dom.connectionStatus, 'Delivered — ready to grab another file');
      }
    });
  });

  dom.fileInput.onchange = async () => {
    const file = dom.fileInput.files[0];
    if (!file) return;
    revokeIfSet(resources.currentImageUrl);
    const objectUrl = URL.createObjectURL(file);
    resources.currentImageUrl = objectUrl;

    sender.send('FILE_SELECTED');
    setImagePreview(dom.senderImage, objectUrl, sanitizeFilename(file.name));
    setFileInfo(dom.senderFileName, dom.senderFileSize, sanitizeFilename(file.name), file.size);
    showScreen(dom.screens, 'sender-grab');
    sender.send('READY');

    try {
      const { tracker } = await startGestureLoop(
        dom.senderVideo,
        async (event) => {
          if (event !== 'grab') return;
          if (!sender.can('GRAB_DETECTED')) return; // already grabbed / in flight

          sender.send('GRAB_DETECTED');
          resources.trackingLoop?.stop();
          stopCameraStream(resources.cameraStream);

          setImagePreview(dom.grabbedImage, objectUrl, sanitizeFilename(file.name));
          showScreen(dom.screens, 'sender-grabbed');

          const dataChannel = resources.peer.dataChannel;
          const fileSender = new FileSender(dataChannel, file, {
            onProgress: ({ progress, speedLabel, etaSeconds }) =>
              setProgressBar(dom.transferBar, dom.transferLabel, progress, speedLabel, etaSeconds),
          });
          resources.fileSender = fileSender;

          dataChannel.send(
            JSON.stringify({
              type: DataChannelMessageType.GRAB_START,
              fileId: fileSender.fileId,
              name: sanitizeFilename(file.name),
              size: file.size,
              mime: file.type || 'application/octet-stream',
            })
          );

          sender.send('TRANSFER_STARTED');
          await fileSender.send();
          sender.send('TRANSFER_COMPLETE');
          setStatusText(dom.connectionStatus, 'Move your hand to the other device');
        },
        (frame) => {
          setGestureStatus(dom.senderGestureStatus, frame);
          if (isDebugMode()) {
            updateDebugPanel(
              dom.debugPanel,
              debugSnapshot({ role: 'sender', appState: sender.state, gesture: frame })
            );
          }
        }
      );
      void tracker;
    } catch (err) {
      handleCameraError(err);
    }
  };

  dom.cancelSenderBtn.onclick = () => {
    resources.fileSender?.cancel();
    cleanupAll();
    location.href = location.pathname; // fresh start, drops ?session=
  };
}

// ---------------------------------------------------------------------------
// RECEIVER
// ---------------------------------------------------------------------------

async function runReceiverFlow(sessionId) {
  const receiver = createReceiverMachine();
  showScreen(dom.screens, 'connected');
  setStatusText(dom.connectionStatus, 'Connecting…');

  const signaling = connectSignaling(sessionId, 'receiver');

  const peer = new GesturePeerConnection({
    signaling,
    onConnectionStateChange: (state) => {
      if (state === 'connected') {
        receiver.send('PAIRED');
        receiver.send('SESSION_READY');
        setStatusText(dom.connectionStatus, 'Device connected');
        showScreen(dom.screens, 'receiver-waiting');
      } else if (state === 'failed' || state === 'disconnected') {
        showError('The other device disconnected.');
      }
    },
    onDataChannel: (channel) => {
      const fileReceiver = new FileReceiver(channel, {
        onProgress: ({ progress, speedLabel }) =>
          setProgressBar(dom.receiverTransferBar, dom.receiverTransferLabel, progress, speedLabel, Infinity),
        onComplete: ({ name, mime, blob }) => {
          const objectUrl = URL.createObjectURL(blob);
          resources.currentImageUrl = objectUrl;
          if (receiver.can('DATA_READY')) {
            receiver.send('DATA_READY');
            revealImage(objectUrl, name, blob.size, mime);
          } else {
            // Fully buffered before PUT — remember it, reveal happens the
            // instant the PUT gesture fires (see below).
            pendingReveal = { objectUrl, name, size: blob.size, mime };
          }
        },
      });
      resources.fileReceiver = fileReceiver;

      channel.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const message = JSON.parse(event.data);
        if (message.type === DataChannelMessageType.GRAB_START) {
          receiver.send('GRAB_START');
          setFileInfo(
            document.getElementById('put-file-name'),
            document.getElementById('put-file-size'),
            sanitizeFilename(message.name),
            message.size
          );
          showScreen(dom.screens, 'receiver-put');
          startReceiverGestureLoop(receiver, channel);
        }
        if (message.type === DataChannelMessageType.FILE_METADATA && receiver.can('TRANSFER_STARTED')) {
          receiver.send('TRANSFER_STARTED');
        }
      });
    },
  });
  resources.peer = peer;

  let pendingReveal = null;

  function revealImage(objectUrl, name, size, mime) {
    setImagePreview(dom.revealImage, objectUrl, sanitizeFilename(name));
    setFileInfo(dom.revealFileName, dom.revealFileMeta, sanitizeFilename(name), size);
    dom.saveReceivedBtn.href = objectUrl;
    dom.saveReceivedBtn.download = sanitizeFilename(name);
    void mime;
    showScreen(dom.screens, 'receiver-reveal');
  }

  async function startReceiverGestureLoop(receiverMachine, channel) {
    try {
      await startGestureLoop(
        dom.receiverVideo,
        (event) => {
          if (event !== 'put') return;
          if (!receiverMachine.can('PUT_GESTURE_DETECTED')) return;

          receiverMachine.send('PUT_GESTURE_DETECTED');
          resources.trackingLoop?.stop();
          stopCameraStream(resources.cameraStream);

          try {
            channel.send(JSON.stringify({ type: DataChannelMessageType.PUT_DETECTED }));
          } catch {
            /* channel may already be closing */
          }

          if (resources.fileReceiver?.isBuffered() && pendingReveal) {
            receiverMachine.send('DATA_READY');
            revealImage(pendingReveal.objectUrl, pendingReveal.name, pendingReveal.size, pendingReveal.mime);
          }
          // If not yet buffered, onComplete (above) will call send('DATA_READY')
          // and reveal the instant the last chunk lands — no restart, no re-fetch.
        },
        (frame) => {
          setGestureStatus(dom.receiverGestureStatus, frame);
          if (isDebugMode()) {
            updateDebugPanel(
              dom.debugPanel,
              debugSnapshot({ role: 'receiver', appState: receiverMachine.state, gesture: frame })
            );
          }
        }
      );
    } catch (err) {
      handleCameraError(err);
    }
  }

  signaling.on(SignalingMessageType.OFFER, async (msg) => {
    const answer = await peer.createAnswerFromOffer(msg.sdp);
    signaling.sendAnswer(answer);
  });
  signaling.on(SignalingMessageType.ICE_CANDIDATE, (msg) => peer.addIceCandidate(msg.candidate));
  signaling.on(SignalingMessageType.PEER_LEFT, () => showError('The other device disconnected.'));

  dom.doneBtn.onclick = () => {
    cleanupAll();
    location.href = location.pathname;
  };
}

function handleCameraError(err) {
  if (err instanceof CameraError) {
    showError(err.message);
  } else {
    showError('Gesture detection is unavailable on this device/browser.');
    console.error(err);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function boot() {
  dom.screens = initScreens();

  const urlSessionId = parseSessionFromUrl(window.location.href);

  dom.pairDeviceBtn.onclick = () => runSenderFlow().catch((err) => showError(err.message));

  dom.scanQrBtn.onclick = async () => {
    showScreen(dom.screens, 'scan-qr');
    try {
      const stream = await requestCamera({ facingMode: 'environment' });
      resources.cameraStream = stream;
      dom.scanVideo.srcObject = stream;
      await dom.scanVideo.play();
      resources.cancelQrScan = scanQrFromVideo(dom.scanVideo, (text) => {
        const sessionId = parseSessionFromUrl(text) || text;
        stopCameraStream(resources.cameraStream);
        resources.cameraStream = null;
        runReceiverFlow(sessionId).catch((err) => showError(err.message));
      });
    } catch (err) {
      handleCameraError(err);
    }
  };

  dom.errorRetry.onclick = () => {
    cleanupAll();
    location.href = location.pathname;
  };

  if (urlSessionId) {
    runReceiverFlow(urlSessionId).catch((err) => showError(err.message));
  } else {
    showScreen(dom.screens, 'welcome');
  }

  if (isDebugMode()) {
    dom.debugPanel.style.display = 'block';
  }

  window.addEventListener('beforeunload', cleanupAll);
}

document.addEventListener('DOMContentLoaded', boot);
