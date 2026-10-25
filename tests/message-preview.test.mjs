import test from 'node:test';
import assert from 'node:assert/strict';
import { previewUserMessage } from '../src/message-preview.mjs';

test('short messages remain exactly unchanged', () => {
  const text = '请检查文件\r\n{"value":9007199254740993}';
  assert.deepEqual(previewUserMessage(text), { text, truncated: false });
});

test('long user messages show only six source lines and leave the original intact', () => {
  const original = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join('\n');
  const result = previewUserMessage(original);
  assert.equal(result.text, 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6');
  assert.equal(result.truncated, true);
  assert.equal(original.split('\n').length, 10);
});

test('long single-line messages stop at 400 complete Unicode code points', () => {
  const original = '字'.repeat(399) + '😀' + '完整原文仍保留';
  const result = previewUserMessage(original);
  assert.equal(Array.from(result.text).length, 400);
  assert.ok(result.text.endsWith('😀'));
  assert.equal(result.truncated, true);
  assert.ok(original.endsWith('完整原文仍保留'));
});
