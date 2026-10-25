/** Presentation only. Callers must keep the original message for quotes/sends. */
export function previewUserMessage(text) {
  const firstLines = text.split('\n').slice(0, 6).join('\n');
  // Count Unicode code points so the preview never splits an emoji surrogate.
  const preview = Array.from(firstLines).slice(0, 400).join('');
  return { text: preview, truncated: preview !== text };
}
