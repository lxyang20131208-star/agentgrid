import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentGridDB } from '../src/coordinator/db.js';
import { Ledger, InsufficientCreditsError } from '../src/coordinator/ledger.js';
import { computeSettlement } from '../src/shared/pricing.js';

function freshLedger(): { db: AgentGridDB; ledger: Ledger } {
  const db = new AgentGridDB(':memory:');
  return { db, ledger: new Ledger(db.raw) };
}

/** The defining invariant of double-entry: every entry sums to zero. */
function assertBooksBalance(db: AgentGridDB): void {
  const row = db.raw
    .prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM entries')
    .get() as { total: number };
  assert.equal(row.total, 0, 'sum of all ledger entries must be zero');
}

test('signup grant mints credits to the user', () => {
  const { db, ledger } = freshLedger();
  ledger.signupGrant('alice', 10_000);
  assert.equal(ledger.userBalance('alice'), 10_000);
  assertBooksBalance(db);
  db.close();
});

test('escrow moves credits from buyer into escrow', () => {
  const { db, ledger } = freshLedger();
  ledger.signupGrant('alice', 10_000);
  ledger.escrowForJob('job1', 'alice', 4_000);
  assert.equal(ledger.userBalance('alice'), 6_000);
  assert.equal(ledger.escrowBalance(), 4_000);
  assertBooksBalance(db);
  db.close();
});

test('escrow rejects a buyer without enough credits', () => {
  const { db, ledger } = freshLedger();
  ledger.signupGrant('alice', 1_000);
  assert.throws(
    () => ledger.escrowForJob('job1', 'alice', 5_000),
    InsufficientCreditsError,
  );
  assert.equal(ledger.userBalance('alice'), 1_000);
  assertBooksBalance(db);
  db.close();
});

test('settling a job pays the worker and refunds the buyer', () => {
  const { db, ledger } = freshLedger();
  ledger.signupGrant('buyer', 10_000);
  ledger.signupGrant('worker', 0);
  ledger.escrowForJob('job1', 'buyer', 5_000);

  const settlement = computeSettlement(1_200, 5_000, 0);
  ledger.settleJob('job1', 'buyer', 'worker', 5_000, settlement);

  assert.equal(ledger.userBalance('worker'), 1_200, 'worker earns the measured cost');
  assert.equal(ledger.userBalance('buyer'), 8_800, 'buyer keeps the unspent budget');
  assert.equal(ledger.escrowBalance(), 0, 'escrow is fully drained');
  assertBooksBalance(db);
  db.close();
});

test('settling with a platform fee splits three ways', () => {
  const { db, ledger } = freshLedger();
  ledger.signupGrant('buyer', 10_000);
  ledger.escrowForJob('job1', 'buyer', 5_000);

  const settlement = computeSettlement(2_000, 5_000, 0.1);
  ledger.settleJob('job1', 'buyer', 'worker', 5_000, settlement);

  assert.equal(ledger.userBalance('worker'), 1_800);
  assert.equal(ledger.userBalance('buyer'), 8_000);
  assert.equal(ledger.escrowBalance(), 0);
  assertBooksBalance(db);
  db.close();
});

test('refunding a job returns the whole escrow to the buyer', () => {
  const { db, ledger } = freshLedger();
  ledger.signupGrant('buyer', 10_000);
  ledger.escrowForJob('job1', 'buyer', 5_000);
  ledger.refundJob('job1', 'buyer', 5_000);

  assert.equal(ledger.userBalance('buyer'), 10_000);
  assert.equal(ledger.escrowBalance(), 0);
  assertBooksBalance(db);
  db.close();
});

test('credits in circulation tracks the live money supply', () => {
  const { db, ledger } = freshLedger();
  ledger.signupGrant('a', 10_000);
  ledger.signupGrant('b', 5_000);
  assert.equal(ledger.creditsInCirculation(), 15_000);

  // Escrow keeps credits in circulation (they move user -> escrow).
  ledger.escrowForJob('job1', 'a', 3_000);
  assert.equal(ledger.creditsInCirculation(), 15_000);
  db.close();
});
