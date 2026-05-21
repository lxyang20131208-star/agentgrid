// Core domain types shared by the coordinator, workers and clients.

/** Identifier of an agent backend a worker can run jobs on. */
export type AdapterName = 'claude-code' | 'codex' | 'mock';

export const ALL_ADAPTERS: AdapterName[] = ['claude-code', 'codex', 'mock'];

/** Token + cost accounting for a single completed job. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Cache-write tokens, when the provider distinguishes them. */
  cacheCreationInputTokens: number;
  /** Cache-read tokens, when the provider distinguishes them. */
  cacheReadInputTokens: number;
  totalTokens: number;
  /**
   * Provider compute cost in USD. Reported directly when the provider exposes
   * it (Claude Code), otherwise estimated from a token-rate table.
   */
  costUsd: number;
  /** True when costUsd was estimated rather than reported by the provider. */
  estimated: boolean;
}

/** A single text file shipped into or out of a job workspace. */
export interface JobFile {
  /** Workspace-relative path, e.g. "src/index.ts". */
  path: string;
  /** UTF-8 file contents. */
  content: string;
}

export type JobStatus =
  | 'queued'
  | 'assigned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** What a buyer asks the network to do. */
export interface JobSpec {
  adapter: AdapterName;
  prompt: string;
  inputFiles: JobFile[];
  /** Maximum credits the buyer is willing to spend; held in escrow. */
  maxCredits: number;
}

/** A job as tracked by the coordinator across its lifecycle. */
export interface Job extends JobSpec {
  id: string;
  buyerId: string;
  workerId: string | null;
  status: JobStatus;
  resultText: string | null;
  outputFiles: JobFile[] | null;
  tokenUsage: TokenUsage | null;
  /** Final credits charged to the buyer once settled. */
  costCredits: number | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkerStatus = 'idle' | 'busy' | 'offline';

export interface WorkerInfo {
  id: string;
  userId: string;
  name: string;
  adapters: AdapterName[];
  status: WorkerStatus;
  /** Total jobs completed by this worker, all-time. */
  jobsCompleted: number;
  /** Total credits earned by this worker, all-time. */
  creditsEarned: number;
  lastSeen: number;
}

export interface PublicWorker {
  id: string;
  name: string;
  adapters: AdapterName[];
  status: WorkerStatus;
  jobsCompleted: number;
  lastSeen: number;
}

export interface AccountInfo {
  userId: string;
  email: string;
  /** Spendable credit balance. */
  balance: number;
  /** Credits currently locked in escrow for in-flight jobs. */
  escrowed: number;
  createdAt: number;
}

export interface NetworkStats {
  users: number;
  workers: number;
  workersOnline: number;
  jobsQueued: number;
  jobsRunning: number;
  jobsCompleted: number;
  creditsInCirculation: number;
  totalTokensMetered: number;
}
