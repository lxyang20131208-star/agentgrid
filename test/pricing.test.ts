import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usdToCredits,
  creditsToUsd,
  estimateCostUsd,
  computeSettlement,
  USD_PER_CREDIT,
} from '../src/shared/pricing.js';

test('usdToCredits and creditsToUsd are consistent', () => {
  assert.equal(usdToCredits(1), 1 / USD_PER_CREDIT);
  assert.equal(creditsToUsd(10_000), 1);
  // Fractional cents round up so a worker is never short-changed.
  assert.equal(usdToCredits(0.00015), 2);
  assert.equal(usdToCredits(0), 0);
});

test('estimateCostUsd uses the per-MTok rate table', () => {
  const cost = estimateCostUsd({ inputPerMTok: 3, outputPerMTok: 15 }, 1_000_000, 1_000_000);
  assert.equal(cost, 18);
});

test('computeSettlement: normal job leaves a refund', () => {
  const s = computeSettlement(1_000, 5_000, 0);
  assert.equal(s.charged, 1_000);
  assert.equal(s.workerEarned, 1_000);
  assert.equal(s.platformFee, 0);
  assert.equal(s.refunded, 4_000);
  assert.equal(s.cappedByBudget, false);
});

test('computeSettlement: job is capped at the escrowed budget', () => {
  const s = computeSettlement(8_000, 5_000, 0);
  assert.equal(s.charged, 5_000);
  assert.equal(s.workerEarned, 5_000);
  assert.equal(s.refunded, 0);
  assert.equal(s.cappedByBudget, true);
});

test('computeSettlement: platform fee is taken from the worker payout', () => {
  const s = computeSettlement(1_000, 5_000, 0.1);
  assert.equal(s.charged, 1_000);
  assert.equal(s.platformFee, 100);
  assert.equal(s.workerEarned, 900);
  assert.equal(s.refunded, 4_000);
  // The whole escrow is always accounted for.
  assert.equal(s.workerEarned + s.platformFee + s.refunded, 5_000);
});
