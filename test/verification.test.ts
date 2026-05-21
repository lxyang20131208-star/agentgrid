import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyUsage } from '../src/shared/verification.js';
import type { TokenUsage } from '../src/shared/types.js';

function usage(partial: Partial<TokenUsage>): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    estimated: true,
    ...partial,
  };
}

test('a clean, plausible report passes unchanged', () => {
  const report = usage({
    inputTokens: 100,
    outputTokens: 100,
    totalTokens: 200,
    costUsd: 0.0004,
    estimated: true,
  });
  const v = verifyUsage(report, 'mock', { inputChars: 400, outputChars: 400 });
  assert.equal(v.ok, true);
  assert.equal(v.verifiedCostUsd, 0.0004);
  assert.deepEqual(v.reasons, []);
});

test('a provider-attested cost is trusted within the absolute ceiling', () => {
  // estimated:false means the provider (e.g. Claude Code) reported the cost.
  const report = usage({
    inputTokens: 1_000,
    outputTokens: 1_000,
    totalTokens: 2_000,
    costUsd: 0.5,
    estimated: false,
  });
  const v = verifyUsage(report, 'claude-code', { inputChars: 4_000, outputChars: 4_000 });
  assert.equal(v.ok, true);
  assert.equal(v.verifiedCostUsd, 0.5, 'provider cost is not clamped');
});

test('an inflated worker-estimated cost is clamped to the rate-table bound', () => {
  const report = usage({
    inputTokens: 10_000,
    outputTokens: 10_000,
    totalTokens: 20_000,
    costUsd: 5.0, // wildly more than 20k tokens could cost
    estimated: true,
  });
  const v = verifyUsage(report, 'codex', { inputChars: 40_000, outputChars: 40_000 });
  assert.equal(v.ok, false);
  assert.ok(v.verifiedCostUsd < 5.0, 'cost was clamped down');
  assert.ok(
    v.reasons.some((r) => r.includes('plausible bound')),
    'flagged as exceeding the plausible bound',
  );
});

test('an absurd cost is clamped by the absolute per-token ceiling', () => {
  const report = usage({
    inputTokens: 50,
    outputTokens: 50,
    totalTokens: 100,
    costUsd: 1_000, // absurd
    estimated: false, // even a "provider-attested" absurd cost is rejected
  });
  const v = verifyUsage(report, 'claude-code', { inputChars: 200, outputChars: 200 });
  assert.equal(v.ok, false);
  assert.ok(v.verifiedCostUsd <= 100 * 0.001, 'clamped to the absolute ceiling');
  assert.ok(v.reasons.some((r) => r.includes('absolute ceiling')));
});

test('a report claiming far too few tokens is flagged', () => {
  const report = usage({
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
    costUsd: 0.001,
    estimated: false, // isolate the floor check from the cost-consistency check
  });
  const v = verifyUsage(report, 'claude-code', {
    inputChars: 5_000,
    outputChars: 5_000,
  });
  assert.equal(v.ok, false);
  assert.ok(
    v.reasons.some((r) => r.includes('floor')),
    'flagged for under-reporting tokens',
  );
  // Under-reporting does not change the bill (it only helps the buyer).
  assert.equal(v.verifiedCostUsd, 0.001);
});
