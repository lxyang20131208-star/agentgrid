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
  /** Result is in and result-checked; in the buyer acceptance window. */
  | 'delivered'
  /** The buyer contested the delivered result; awaiting arbitration. */
  | 'disputed'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * A record of where a job's token figures came from. Captured by the worker's
 * adapter and stored immutably with the job so metering is auditable.
 */
export interface Attestation {
  /** The upstream provider, e.g. "anthropic", "openai", "mock". */
  provider: string;
  /** The model id, when the provider reports one. */
  model: string | null;
  /** True when the cost figure originated from the provider's own response. */
  providerReportedCost: boolean;
  /** SHA-256 of the raw provider response the usage was parsed from. */
  rawResponseDigest: string;
}

/** Outcome of the coordinator's structural check of a job result. */
export interface ResultCheck {
  ok: boolean;
  reasons: string[];
}

/** How an arbitration was resolved. */
export type Resolution = 'worker' | 'buyer';

/** The credit split for a settled job. See pricing.computeSettlement. */
export interface Settlement {
  /** Credits charged to the buyer (<= escrowed). */
  charged: number;
  /** Credits paid to the worker. */
  workerEarned: number;
  /** Credits taken as platform fee. */
  platformFee: number;
  /** Credits returned to the buyer from the escrow remainder. */
  refunded: number;
  /** True when the job hit its budget cap. */
  cappedByBudget: boolean;
}

/** What a buyer asks the network to do. */
export interface JobSpec {
  adapter: AdapterName;
  prompt: string;
  inputFiles: JobFile[];
  /** Maximum credits the buyer is willing to spend; held in escrow. */
  maxCredits: number;
  /**
   * Highest worker price multiplier the buyer will accept. A worker pricing
   * itself above this is not matched to the job. Defaults to no limit.
   */
  maxPriceMultiplier?: number;
}

/** Result of checking a worker's token-usage report. */
export interface JobVerification {
  /** True when the report passed every check unchanged. */
  ok: boolean;
  /** The cost the coordinator actually billed, in USD. */
  verifiedCostUsd: number;
  /** Reasons the report was adjusted or flagged, if any. */
  reasons: string[];
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
  /** Outcome of token-usage verification, set when the job completes. */
  verification: JobVerification | null;
  /** Where the token figures came from — set when a result arrives. */
  attestation: Attestation | null;
  /** Outcome of the structural result check — set when a result arrives. */
  resultCheck: ResultCheck | null;
  /** Computed credit split, held while a delivered job awaits acceptance. */
  settlement: Settlement | null;
  /** When the result was delivered (start of the acceptance window). */
  deliveredAt: number | null;
  /** Set when a disputed job is arbitrated. */
  resolution: Resolution | null;
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
  /** Total jobs that failed while assigned to this worker, all-time. */
  jobsFailed: number;
  /** Token-usage reports the coordinator flagged as implausible. */
  flaggedReports: number;
  /** Total credits earned by this worker, all-time. */
  creditsEarned: number;
  /** The worker's price: buyers are charged measuredCost * priceMultiplier. */
  priceMultiplier: number;
  /** Maximum jobs this worker runs concurrently. */
  capacity: number;
  lastSeen: number;
}

export interface PublicWorker {
  id: string;
  name: string;
  adapters: AdapterName[];
  status: WorkerStatus;
  jobsCompleted: number;
  jobsFailed: number;
  /** Computed 0-100 reputation score. */
  reputation: number;
  priceMultiplier: number;
  capacity: number;
  /** Jobs the worker is running right now. */
  activeJobs: number;
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
