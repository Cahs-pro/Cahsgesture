// src/ui/screens.js
//
// Small view layer: swaps which <section data-screen="..."> is visible and
// updates text/attributes on specific elements. Every piece of text that
// could ever come from the network or from a filename uses `textContent`
// (via setSafeText) — never innerHTML — per the security requirements.

import { setSafeText, formatFileSize } from '../utils/sanitize.js';

const SCREEN_IDS = [
  'welcome',
  'qr-pairing',
  'scan-qr',
  'connected',
  'sender-select',
  'sender-grab',
  'sender-grabbed',
  'receiver-waiting',
  'receiver-put',
  'receiver-reveal',
  'error',
];

export function initScreens(root = document) {
  const screens = new Map();
  for (const id of SCREEN_IDS) {
    const el = root.querySelector(`[data-screen="${id}"]`);
    if (el) screens.set(id, el);
  }
  return screens;
}

export function showScreen(screens, id) {
  for (const [screenId, el] of screens) {
    el.classList.toggle('screen--active', screenId === id);
    el.setAttribute('aria-hidden', String(screenId !== id));
  }
  const active = screens.get(id);
  if (active) {
    const heading = active.querySelector('h1, h2');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus?.();
  }
}

export function setStatusText(el, text) {
  if (el) setSafeText(el, text);
}

export function setFileInfo(nameEl, sizeEl, name, size) {
  setSafeText(nameEl, name);
  setSafeText(sizeEl, formatFileSize(size));
}

export function setImagePreview(imgEl, objectUrl, altText) {
  imgEl.src = objectUrl;
  imgEl.alt = altText;
}

export function setProgressBar(barEl, labelEl, progress01, speedLabel, etaSeconds) {
  const pct = Math.round(progress01 * 100);
  barEl.style.width = `${pct}%`;
  barEl.setAttribute('aria-valuenow', String(pct));
  const etaText =
    Number.isFinite(etaSeconds) && etaSeconds >= 0 ? ` · ETA ${formatEta(etaSeconds)}` : '';
  setSafeText(labelEl, `${pct}% · ${speedLabel || ''}${etaText}`);
}

function formatEta(seconds) {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

export function setGestureStatus(el, { handDetected, zone, openness }) {
  if (!handDetected) {
    setSafeText(el, 'Show your hand');
    el.dataset.state = 'none';
    return;
  }
  if (zone === 'open') {
    setSafeText(el, 'Hand detected');
    el.dataset.state = 'open';
  } else if (zone === 'closed') {
    setSafeText(el, 'Grip detected');
    el.dataset.state = 'closed';
  } else {
    setSafeText(el, 'Hold steady…');
    el.dataset.state = 'ambiguous';
  }
}

export function updateDebugPanel(el, info) {
  if (!el) return;
  const lines = Object.entries(info).map(([key, value]) => `${key}: ${value}`);
  setSafeText(el, lines.join('\n'));
}

export function revokeIfSet(url) {
  if (url) URL.revokeObjectURL(url);
}
