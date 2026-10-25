import assert from 'node:assert/strict';
import test from 'node:test';
import { browserViewportLayout, DESKTOP_VIEWPORT_WIDTH } from '../src/browser-viewport.mjs';

test('fit mode preserves a desktop viewport while filling narrow and wide panes', () => {
  for (const width of [280, 420, 960, 1280, 1600]) {
    const layout = browserViewportLayout({ width, height: 530 });
    assert.equal(layout.frameWidth, Math.max(DESKTOP_VIEWPORT_WIDTH, width));
    assert(Math.abs(layout.frameWidth * layout.scale - width) < 0.00001);
    assert(Math.abs(layout.frameHeight * layout.scale - 530) < 0.00001);
    assert.equal(layout.canvasWidth, width);
    assert.equal(layout.canvasHeight, 530);
    assert(layout.scale <= 1, 'wide panes should not magnify desktop content');
  }
});

test('actual size leaves the complete desktop width scrollable while responsive mode uses the pane', () => {
  const actual = browserViewportLayout({ width: 420, height: 300 }, 'actual');
  assert.equal(actual.canvasWidth, 1280);
  assert.equal(actual.frameWidth, 1280);
  assert.equal(actual.frameHeight, 300);
  assert.equal(actual.scale, 1);
  const responsive = browserViewportLayout({ width: 420, height: 300 }, 'responsive');
  assert.equal(responsive.canvasWidth, 420);
  assert.equal(responsive.frameWidth, 420);
  assert.equal(responsive.frameHeight, 300);
  assert.equal(responsive.scale, 1);
});

test('unmeasured layouts produce finite initial dimensions', () => {
  for (const size of [undefined, {}, { width: 0, height: 0 }, { width: NaN, height: Infinity }]) {
    const layout = browserViewportLayout(size);
    assert(Object.values(layout).every(value => Number.isFinite(value) && value > 0));
  }
});
