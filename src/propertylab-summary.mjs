// JSON.parse validates structure, but its Number values must never be used to
// re-serialize evidence: valid PropertyLab counterexamples can exceed 2 ** 53.
// These small scanners retain the original value tokens, including nested data.
const skipWhitespace = (text, start) => {
  let at = start;
  while (at < text.length && /\s/.test(text[at])) at += 1;
  return at;
};

function stringEnd(text, start) {
  let at = start + 1;
  while (at < text.length) {
    if (text[at] === '\\') at += 2;
    else if (text[at++] === '"') return at;
  }
  throw new SyntaxError('Unclosed JSON string');
}

function valueEnd(text, start) {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== '{' && text[start] !== '[') {
    let at = start;
    while (at < text.length && !/[\s,}\]]/.test(text[at])) at += 1;
    return at;
  }
  let depth = 0;
  let at = start;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') { at = stringEnd(text, at); continue; }
    if (character === '{' || character === '[') depth += 1;
    if (character === '}' || character === ']') {
      depth -= 1;
      if (depth === 0) return at + 1;
    }
    at += 1;
  }
  throw new SyntaxError('Unclosed JSON value');
}

// Called only after full JSON validation. Last duplicate key wins, exactly as
// JSON.parse does; quoted delimiters and escaped field names stay unambiguous.
function objectMembers(text, start) {
  const members = new Map();
  let at = skipWhitespace(text, start + 1);
  while (text[at] !== '}') {
    const keyEnd = stringEnd(text, at);
    const key = JSON.parse(text.slice(at, keyEnd));
    at = skipWhitespace(text, keyEnd);
    at = skipWhitespace(text, at + 1); // colon
    const end = valueEnd(text, at);
    members.set(key, { start: at, end });
    at = skipWhitespace(text, end);
    if (text[at] === ',') at = skipWhitespace(text, at + 1);
  }
  return members;
}

/** Read only a single report, or a result/report wrapper, without altering values. */
export function parsePropertyLabSummary(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const rootMembers = objectMembers(text, skipWhitespace(text, 0));
    const candidates = [{ value: parsed, members: rootMembers }];
    for (const key of ['result', 'report']) {
      const value = parsed[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        candidates.push({ value, members: objectMembers(text, rootMembers.get(key).start) });
      }
    }
    const candidate = candidates.find(({ members }) => members.has('evaluations')
      && ['status', 'counterexample', 'minimal_counterexample', 'minimalCounterexample'].some((key) => members.has(key)));
    if (!candidate) return null;
    const { value, members } = candidate;
    const raw = (key) => {
      const span = members.get(key);
      return span ? text.slice(span.start, span.end) : undefined;
    };
    const counterexampleKey = ['minimal_counterexample', 'minimalCounterexample', 'counterexample', 'minimal'].find((key) => members.has(key));
    return {
      statusText: typeof value.status === 'string' ? value.status : raw('status') || '未提供',
      evaluationsText: Array.isArray(value.evaluations) ? String(value.evaluations.length) : typeof value.evaluations === 'number' ? raw('evaluations') : '见详情',
      evaluationsRaw: raw('evaluations'),
      counterexampleRaw: counterexampleKey ? raw(counterexampleKey) : undefined,
      hasCounterexampleValue: Boolean(counterexampleKey),
      hasCounterexample: value.has_counterexample,
    };
  } catch { return null; }
}
