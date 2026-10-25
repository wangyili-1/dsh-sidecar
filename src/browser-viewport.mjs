export const DESKTOP_VIEWPORT_WIDTH = 1280;

/** Fit a desktop viewport without inspecting the cross-origin page document. */
export function browserViewportLayout(size, mode = 'fit') {
  const width = Number.isFinite(size?.width) && size.width > 0 ? size.width : 420;
  const height = Number.isFinite(size?.height) && size.height > 0 ? size.height : 480;
  const frameWidth = mode === 'responsive' ? width : Math.max(DESKTOP_VIEWPORT_WIDTH, width);
  const scale = mode === 'fit' ? Math.min(1, width / frameWidth) : 1;
  return {
    frameWidth,
    frameHeight: height / scale,
    scale,
    canvasWidth: mode === 'actual' ? frameWidth : width,
    canvasHeight: height,
  };
}
