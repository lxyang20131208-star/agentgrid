// SQLite persistence layer for the coordinator.
//
// Owns the full schema (users, workers, jobs, and the ledger tables) and
// exposes typed accessors. The ledger logic itself lives in ledger.ts but
// operates on the same connection so credit moves and job updates can share
// a transaction.

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  AdapterName,
  Job,
  JobFile,
  JobStatus,
  TokenUsage,
  WorkerInfo,
  WorkerStatus,
} from '../shared/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  api_key_hash  TEXT UNIQUE NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id),
  name             TEXT NOT NULL,
  adapters         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'offline',
  jobs_completed   INTEGER NOT NULL DEFAULT 0,
  jobs_failed      INTEGER NOT NULL DEFAULT 0,
  flagged_reports  INTEGER NOT NULL DEFAULT 0,
  credits_earned   INTEGER NOT NULL DEFAULT 0,
  price_multiplier REAL NOT NULL DEFAULT 1.0,
  last_seen        INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  buyer_id      TEXT NOT NULL REFERENCES users(id),
  worker_id     TEXT REFERENCES workers(id),
  adapter       TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  input_files   TEXT NOT NULL,
  max_credits   INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued',
  result_text   TEXT,
  output_files  TEXT,
  token_usage   TEXT,
  cost_credits  INTEGER,
  verification  TEXT,
  max_price_multiplier REAL,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  owner_id    TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  job_id      TEXT,
  memo        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id          TEXT PRIMARY KEY,
  tx_id       TEXT NOT NULL REFERENCES transactions(id),
  account_id  TEXT NOT NULL REFERENCES accounts(id),
  amount      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_buyer  ON jobs(buyer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_entries_account ON entries(account_id);
CREATE INDEX IF NOT EXISTS idx_entries_tx ON entries(tx_id);
`;

interface UserRow {
  id: string;
  email: string;
  api_key_hash: string;
  created_at: number;
}

interface WorkerRow {
  id: string;
  user_id: string;
  name: string;
  adapters: string;
  status: string;
  jobs_completed: number;
  jobs_failed: number;
  flagged_reports: number;
  credits_earned: number;
  price_multiplier: number;
  last_seen: number;
  created_at: number;
}

interface JobRow {
  id: string;
  buyer_id: string;
  worker_id: string | null;
  adapter: string;
  prompt: string;
  input_files: string;
  max_credits: number;
  status: string;
  result_text: string | null;
  output_files: string | null;
  token_usage: string | null;
  cost_credits: number | null;
  verification: string | null;
  max_price_multiplier: number | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface User {
  id: string;
  email: string;
  apiKeyHash: string;
  createdAt: number;
}

function rowToUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    apiKeyHash: r.api_key_hash,
    createdAt: r.created_at,
  };
}

function rowToWorker(r: WorkerRow): WorkerInfo {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    adapters: JSON.parse(r.adapters) as AdapterName[],
    status: r.status as WorkerStatus,
    jobsCompleted: r.jobs_completed,
    jobsFailed: r.jobs_failed,
    flaggedReports: r.flagged_reports,
    creditsEarned: r.credits_earned,
    priceMultiplier: r.price_multiplier,
    lastSeen: r.last_seen,
  };
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    buyerId: r.buyer_id,
    workerId: r.worker_id,
    adapter: r.adapter as AdapterName,
    prompt: r.prompt,
    inputFiles: JSON.parse(r.input_files) as JobFile[],
    maxCredits: r.max_credits,
    maxPriceMultiplier: r.max_price_multiplier ?? undefined,
    status: r.status as JobStatus,
    resultText: r.result_text,
    outputFiles: r.output_files ? (JSON.parse(r.output_files) as JobFile[]) : null,
    tokenUsage: r.token_usage ? (JSON.parse(r.token_usage) as TokenUsage) : null,
    costCredits: r.cost_credits,
    verification: r.verification
      ? (JSON.parse(r.verification) as Job['verification'])
      : null,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Thin typed wrapper over a better-sqlite3 connection. */
export class AgentGridDB {
  readonly raw: Database.Database;

  constructor(path: string) {
    this.raw = new Database(path);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');
    this.raw.exec(SCHEMA);
    this.migrate();
  }

  close(): void {
    this.raw.close();
  }

  /** Add columns introduced after v0.1 to databases created by older builds. */
  private migrate(): void {
    this.addColumnIfMissing('workers', 'jobs_failed', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('workers', 'flagged_reports', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('workers', 'price_multiplier', 'REAL NOT NULL DEFAULT 1.0');
    this.addColumnIfMissing('jobs', 'verification', 'TEXT');
    this.addColumnIfMissing('jobs', 'max_price_multiplier', 'REAL');
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const cols = this.raw
      .prepare(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  // --- Users ---------------------------------------------------------------

  createUser(email: string, apiKeyHash: string): User {
    const user: User = {
      id: `usr_${randomUUID()}`,
      email,
      apiKeyHash,
      createdAt: Date.now(),
    };
    this.raw
      .prepare(
        'INSERT INTO users (id, email, api_key_hash, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(user.id, user.email, user.apiKeyHash, user.createdAt);
    return user;
  }

  getUserByApiKeyHash(hash: string): User | null {
    const row = this.raw
      .prepare('SELECT * FROM users WHERE api_key_hash = ?')
      .get(hash) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  getUserById(id: string): User | null {
    const row = this.raw
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  getUserByEmail(email: string): User | null {
    const row = this.raw
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  countUsers(): number {
    return (
      this.raw.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }
    ).n;
  }

  // --- Workers -------------------------------------------------------------

  upsertWorker(
    userId: string,
    name: string,
    adapters: AdapterName[],
    priceMultiplier: number,
  ): WorkerInfo {
    // One worker row per (user, name) pair; re-registering reuses it so
    // lifetime stats and reputation survive reconnects.
    const existing = this.raw
      .prepare('SELECT id FROM workers WHERE user_id = ? AND name = ?')
      .get(userId, name) as { id: string } | undefined;
    const now = Date.now();
    let id: string;
    if (existing) {
      id = existing.id;
      this.raw
        .prepare(
          `UPDATE workers
           SET adapters = ?, status = 'idle', price_multiplier = ?, last_seen = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(adapters), priceMultiplier, now, id);
    } else {
      id = `wrk_${randomUUID()}`;
      this.raw
        .prepare(
          `INSERT INTO workers
             (id, user_id, name, adapters, status, jobs_completed, jobs_failed,
              flagged_reports, credits_earned, price_multiplier, last_seen, created_at)
           VALUES (?, ?, ?, ?, 'idle', 0, 0, 0, 0, ?, ?, ?)`,
        )
        .run(id, userId, name, JSON.stringify(adapters), priceMultiplier, now, now);
    }
    return rowToWorker(
      this.raw.prepare('SELECT * FROM workers WHERE id = ?').get(id) as WorkerRow,
    );
  }

  getWorker(id: string): WorkerInfo | null {
    const row = this.raw
      .prepare('SELECT * FROM workers WHERE id = ?')
      .get(id) as WorkerRow | undefined;
    return row ? rowToWorker(row) : null;
  }

  setWorkerStatus(id: string, status: WorkerStatus): void {
    this.raw
      .prepare('UPDATE workers SET status = ?, last_seen = ? WHERE id = ?')
      .run(status, Date.now(), id);
  }

  recordWorkerCompletion(id: string, creditsEarned: number): void {
    this.raw
      .prepare(
        `UPDATE workers
         SET jobs_completed = jobs_completed + 1,
             credits_earned = credits_earned + ?,
             last_seen = ?
         WHERE id = ?`,
      )
      .run(creditsEarned, Date.now(), id);
  }

  recordWorkerFailure(id: string): void {
    this.raw
      .prepare(
        'UPDATE workers SET jobs_failed = jobs_failed + 1, last_seen = ? WHERE id = ?',
      )
      .run(Date.now(), id);
  }

  recordWorkerFlag(id: string): void {
    this.raw
      .prepare(
        'UPDATE workers SET flagged_reports = flagged_reports + 1 WHERE id = ?',
      )
      .run(id);
  }

  listWorkers(): WorkerInfo[] {
    return (
      this.raw.prepare('SELECT * FROM workers ORDER BY created_at').all() as WorkerRow[]
    ).map(rowToWorker);
  }

  // --- Jobs ----------------------------------------------------------------

  createJob(
    buyerId: string,
    adapter: AdapterName,
    prompt: string,
    inputFiles: JobFile[],
    maxCredits: number,
    maxPriceMultiplier: number | null,
  ): Job {
    const now = Date.now();
    const id = `job_${randomUUID()}`;
    this.raw
      .prepare(
        `INSERT INTO jobs
           (id, buyer_id, worker_id, adapter, prompt, input_files, max_credits,
            max_price_multiplier, status, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        buyerId,
        adapter,
        prompt,
        JSON.stringify(inputFiles),
        maxCredits,
        maxPriceMultiplier,
        now,
        now,
      );
    return this.getJob(id)!;
  }

  getJob(id: string): Job | null {
    const row = this.raw
      .prepare('SELECT * FROM jobs WHERE id = ?')
      .get(id) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  updateJob(id: string, patch: Partial<Omit<Job, 'id'>>): void {
    const current = this.getJob(id);
    if (!current) throw new Error(`job ${id} not found`);
    const next: Job = { ...current, ...patch, updatedAt: Date.now() };
    this.raw
      .prepare(
        `UPDATE jobs SET
           worker_id = ?, status = ?, result_text = ?, output_files = ?,
           token_usage = ?, cost_credits = ?, verification = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.workerId,
        next.status,
        next.resultText,
        next.outputFiles ? JSON.stringify(next.outputFiles) : null,
        next.tokenUsage ? JSON.stringify(next.tokenUsage) : null,
        next.costCredits,
        next.verification ? JSON.stringify(next.verification) : null,
        next.error,
        next.updatedAt,
        id,
      );
  }

  listJobsByBuyer(buyerId: string, limit = 50): Job[] {
    return (
      this.raw
        .prepare('SELECT * FROM jobs WHERE buyer_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(buyerId, limit) as JobRow[]
    ).map(rowToJob);
  }

  listJobsByStatus(status: JobStatus): Job[] {
    return (
      this.raw
        .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at')
        .all(status) as JobRow[]
    ).map(rowToJob);
  }

  countJobsByStatus(status: JobStatus): number {
    return (
      this.raw
        .prepare('SELECT COUNT(*) AS n FROM jobs WHERE status = ?')
        .get(status) as { n: number }
    ).n;
  }

  /** Sum of total tokens across every job that carries usage data. */
  totalTokensMetered(): number {
    const rows = this.raw
      .prepare('SELECT token_usage FROM jobs WHERE token_usage IS NOT NULL')
      .all() as { token_usage: string }[];
    let total = 0;
    for (const r of rows) {
      try {
        total += (JSON.parse(r.token_usage) as TokenUsage).totalTokens;
      } catch {
        // Skip unparseable rows rather than failing the stats query.
      }
    }
    return total;
  }
}
