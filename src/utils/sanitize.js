// src/utils/sanitize.js
//
// Filenames come from the OS file picker on one device and are shown as
// text — and sent as metadata — on a different device. Never trust them.

const MAX_FILENAME_LENGTH = 180;
// Control characters, path separators, and characters that are meaningless
// or dangerous in a displayed filename.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/**
 * Produces a safe-to-display, safe-to-store filename: no path components,
 * no control characters, bounded length, never empty.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'file';

  // Drop any path the browser/OS might have left in (defense in depth —
  // <input type="file"> already gives us a basename, but never assume).
  const basename = name.split(/[\\/]/).pop() ?? name;

  const cleaned = basename
    .replace(UNSAFE_CHARS, '_')
    .replace(/^\.+/, '') // no leading dot-only hidden-file tricks
    .trim();

  const safe = cleaned.length > 0 ? cleaned : 'file';
  return safe.length > MAX_FILENAME_LENGTH ? safe.slice(0, MAX_FILENAME_LENGTH) : safe;
}

/**
 * Renders `text` into `element` using a text node — never innerHTML — so
 * a filename or any other peer-supplied string can never be interpreted
 * as markup.
 * @param {{textContent: string}} element
 * @param {string} text
 */
export function setSafeText(element, text) {
  element.textContent = String(text);
}

/**
 * Human-readable file size, e.g. "2.4 MB".
 * @param {number} bytes
 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
