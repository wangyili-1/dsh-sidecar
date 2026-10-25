import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePropertyLabSummary } from '../src/propertylab-summary.mjs';

test('preserves the humanize counterexample above the safe integer boundary', () => {
  const input = '{"status":"counterexample","has_counterexample":true,"counterexample":9007199254740993,"evaluations":146}';
  const result = parsePropertyLabSummary(input);
  assert.equal(JSON.parse(input).counterexample, 9007199254740992, 'regression fixture actually exercises Number precision loss');
  assert.equal(result.counterexampleRaw, '9007199254740993');
  assert.equal(result.evaluationsText, '146');
});

test('preserves unsafe values inside nested evidence and escaped delimiters', () => {
  const evidence = '[9007199254740993, {"negative": -9007199254740995, "huge": 1e400, "text": "brace } and escaped \\"quote\\""}]';
  const result = parsePropertyLabSummary(`{"status":"counterexample","counterexample":${evidence},"evaluations":9007199254740993}`);
  assert.equal(result.counterexampleRaw, evidence);
  assert.equal(result.evaluationsText, '9007199254740993');
  assert.equal(result.evaluationsRaw, '9007199254740993');
});

test('distinguishes a real null counterexample from no counterexample', () => {
  const real = parsePropertyLabSummary('{"status":"counterexample","has_counterexample":true,"counterexample":null,"evaluations":3}');
  assert.equal(real.hasCounterexample, true);
  assert.equal(real.hasCounterexampleValue, true);
  assert.equal(real.counterexampleRaw, 'null');
  const absent = parsePropertyLabSummary('{"status":"no_counterexample","has_counterexample":false,"counterexample":null,"evaluations":100}');
  assert.equal(absent.hasCounterexample, false);
  assert.equal(absent.counterexampleRaw, 'null');
});

test('reads ordinary reports and report/result wrappers without rewriting strings', () => {
  const report = '{"status":"counterexample","counterexample":"\\u001f","evaluations":29}';
  for (const input of [report, `{"report":${report}}`, `{"result":${report}}`]) {
    const result = parsePropertyLabSummary(input);
    assert.equal(result.statusText, 'counterexample');
    assert.equal(result.counterexampleRaw, '"\\u001f"');
    assert.equal(result.evaluationsText, '29');
  }
});

test('matches JSON semantics for duplicate and escaped member names', () => {
  const result = parsePropertyLabSummary('{"status":"counterexample","counterexample":1,"\\u0063ounterexample":9007199254740993,"evaluations":2}');
  assert.equal(result.counterexampleRaw, '9007199254740993');
});

test('leaves invalid, truncated and unrelated JSON to the plain file viewer', () => {
  for (const input of ['', '{"counterexample":', 'null', '[]', '{"name":"ordinary file"}']) {
    assert.equal(parsePropertyLabSummary(input), null);
  }
});
