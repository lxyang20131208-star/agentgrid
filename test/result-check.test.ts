import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkResult, isResultUsable } from '../src/shared/result-check.js';

test('a normal result passes the structural check', () => {
  const r = checkResult('Here is the refactored function...', []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test('a result with output files but no text is still usable', () => {
  assert.equal(isResultUsable('', [{ path: 'out.ts', content: 'export {}' }]), true);
  const r = checkResult('', [{ path: 'out.ts', content: 'export {}' }]);
  assert.equal(r.ok, true);
});

test('an empty result with no files is unusable and flagged', () => {
  assert.equal(isResultUsable('   ', []), false);
  const r = checkResult('   ', []);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('empty')));
});

test('a result that is actually an error dump is flagged', () => {
  const r = checkResult('Error: command failed with exit code 1', []);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('error message')));
});

test('an implausibly large result is flagged', () => {
  const huge = 'x'.repeat(6_000_000);
  const r = checkResult(huge, []);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => x.includes('implausibly large')));
});
