import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeFilename, formatFileSize, setSafeText } from '../src/utils/sanitize.js';

test('sanitizeFilename strips path components', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('C:\\Users\\me\\photo.jpg'), 'photo.jpg');
});

test('sanitizeFilename strips control characters and dangerous punctuation', () => {
  assert.equal(sanitizeFilename('evil\u0000name<script>.jpg'), 'evil_name_script_.jpg');
});

test('sanitizeFilename never returns an empty string', () => {
  assert.equal(sanitizeFilename(''), 'file');
  assert.equal(sanitizeFilename('....'), 'file');
  assert.equal(sanitizeFilename(null), 'file');
  assert.equal(sanitizeFilename(undefined), 'file');
});

test('sanitizeFilename bounds the length', () => {
  const long = 'a'.repeat(500) + '.png';
  const result = sanitizeFilename(long);
  assert.ok(result.length <= 180);
});

test('setSafeText assigns textContent, never innerHTML', () => {
  const fakeElement = { textContent: '', innerHTML: '' };
  setSafeText(fakeElement, '<img src=x onerror=alert(1)>');
  assert.equal(fakeElement.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(fakeElement.innerHTML, ''); // never touched
});

test('formatFileSize', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(500), '500 B');
  assert.equal(formatFileSize(2_400_000), '2.3 MB');
  assert.equal(formatFileSize(1024), '1.0 KB');
});
