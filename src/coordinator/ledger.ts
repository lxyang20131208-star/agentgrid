// Double-entry credit ledger.
//
// Every credit movement is a transaction made of two or more entries whose
// amounts sum to zero. An account's balance is the sum of its entries. This
// makes the books self-checking: the total of every entry in the database is
// always zero, so credits can never be created or destroyed except by the
// `system` account (the mint).

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Settlement } from '../shared/pricing.js';

/** Fixed account ids — there is exactly one system and one escrow account. */
const SYSTEM_ACCOUNT = 'acct_system';
const ESCROW_ACCOUNT = 'acct_escrow';

function userAccountId(userId: string): string {
  return `acct_user_${userId}`;
}

interface Leg {
  accountId: string;
  /** Positive credits the account, negative debits it. */
  amount: number;
}

type TxKind =
  | 'signup_grant'
  | 'job_escrow'
  | 'job_settle'
  | 'job_refund';

export class Ledger {
  constructor(private readonly db: Database.Database) {
    this.ensureAccount(SYSTEM_ACCOUNT, 'system', null);
    this.ensureAccount(ESCROW_ACCOUNT, 'escrow', null);
  }

  private ensureAccount(
    id: string,
    kind: string,
    ownerId: string | null,
  ): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO accounts (id, kind, owner_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, kind, ownerId, Date.now());
  }

  /** Create the credit account for a user. Idempotent. */
  ensureUserAccount(userId: string): void {
    this.ensureAccount(userAccountId(userId), 'user', userId);
  }

  /** Sum of every entry for an account. */
  balance(accountId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(amount), 0) AS bal FROM entries WHERE account_id = ?')
      .get(accountId) as { bal: number };
    return row.bal;
  }

  userBalance(userId: string): number {
    return this.balance(userAccountId(userId));
  }

  escrowBalance(): number {
    return this.balance(ESCROW_ACCOUNT);
  }

  /** Total credits held by users — the live money supply. */
  creditsInCirculation(): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) AS bal
         FROM entries e JOIN accounts a ON a.id = e.account_id
         WHERE a.kind IN ('user', 'escrow')`,
      )
      .get() as { bal: number };
    return row.bal;
  }

  /**
   * Post a balanced transaction. Throws if the legs do not sum to zero, so a
   * coding error can never silently unbalance the books.
   */
  private post(kind: TxKind, jobId: string | null, memo: string, legs: Leg[]): void {
    const sum = legs.reduce((s, l) => s + l.amount, 0);
    if (sum !== 0) {
      throw new Error(`unbalanced transaction (${kind}): legs sum to ${sum}`);
    }
    const now = Date.now();
    const txId = `tx_${randomUUID()}`;
    const insertTx = this.db.prepare(
      'INSERT INTO transactions (id, kind, job_id, memo, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const insertEntry = this.db.prepare(
      'INSERT INTO entries (id, tx_id, account_id, amount, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const run = this.db.transaction(() => {
      insertTx.run(txId, kind, jobId, memo, now);
      for (const leg of legs) {
        insertEntry.run(`ent_${randomUUID()}`, txId, leg.accountId, leg.amount, now);
      }
    });
    run();
  }

  /** Mint `amount` credits into a new user's account from the system account. */
  signupGrant(userId: string, amount: number): void {
    if (amount <= 0) return;
    this.ensureUserAccount(userId);
    this.post('signup_grant', null, `signup grant for ${userId}`, [
      { accountId: SYSTEM_ACCOUNT, amount: -amount },
      { accountId: userAccountId(userId), amount },
    ]);
  }

  /**
   * Move a job's budget from the buyer into escrow. Throws if the buyer has
   * insufficient balance — callers must surface this as a 402-style error.
   */
  escrowForJob(jobId: string, buyerId: string, amount: number): void {
    this.ensureUserAccount(buyerId);
    if (this.userBalance(buyerId) < amount) {
      throw new InsufficientCreditsError(buyerId, amount, this.userBalance(buyerId));
    }
    this.post('job_escrow', jobId, `escrow for job ${jobId}`, [
      { accountId: userAccountId(buyerId), amount: -amount },
      { accountId: ESCROW_ACCOUNT, amount },
    ]);
  }

  /**
   * Settle a finished job: pay the worker, take the platform fee, and refund
   * the buyer's unspent budget. `escrowed` must equal the amount escrowed.
   */
  settleJob(
    jobId: string,
    buyerId: string,
    workerUserId: string,
    escrowed: number,
    settlement: Settlement,
  ): void {
    this.ensureUserAccount(workerUserId);
    const legs: Leg[] = [{ accountId: ESCROW_ACCOUNT, amount: -escrowed }];
    if (settlement.workerEarned > 0) {
      legs.push({ accountId: userAccountId(workerUserId), amount: settlement.workerEarned });
    }
    if (settlement.platformFee > 0) {
      legs.push({ accountId: SYSTEM_ACCOUNT, amount: settlement.platformFee });
    }
    if (settlement.refunded > 0) {
      legs.push({ accountId: userAccountId(buyerId), amount: settlement.refunded });
    }
    this.post('job_settle', jobId, `settle job ${jobId}`, legs);
  }

  /** Return a job's full escrowed budget to the buyer (failure/cancellation). */
  refundJob(jobId: string, buyerId: string, escrowed: number): void {
    if (escrowed <= 0) return;
    this.post('job_refund', jobId, `refund job ${jobId}`, [
      { accountId: ESCROW_ACCOUNT, amount: -escrowed },
      { accountId: userAccountId(buyerId), amount: escrowed },
    ]);
  }
}

export class InsufficientCreditsError extends Error {
  constructor(
    readonly userId: string,
    readonly required: number,
    readonly available: number,
  ) {
    super(
      `insufficient credits: need ${required}, have ${available}`,
    );
    this.name = 'InsufficientCreditsError';
  }
}
