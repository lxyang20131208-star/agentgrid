// WebSocket wire protocol between workers and the coordinator.
//
// Every message is a JSON object with a `type` discriminator. Schemas are
// validated with zod on receipt so a malformed peer cannot crash the process.

import { z } from 'zod';

export const ADAPTER = z.enum(['claude-code', 'codex', 'mock']);

export const JOB_FILE = z.object({
  path: z.string().min(1).max(512),
  content: z.string().max(1_000_000),
});

export const TOKEN_USAGE = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  estimated: z.boolean(),
});

// --- Worker -> Coordinator -------------------------------------------------

export const WORKER_REGISTER = z.object({
  type: z.literal('register'),
  name: z.string().min(1).max(64),
  adapters: z.array(ADAPTER).min(1),
  /** The worker's price: buyers pay measuredCost * priceMultiplier. */
  priceMultiplier: z.number().min(0.1).max(100).optional(),
  /** Maximum jobs this worker runs concurrently. */
  capacity: z.number().int().min(1).max(64).optional(),
});

export const ATTESTATION = z.object({
  provider: z.string().max(64),
  model: z.string().max(128).nullable(),
  providerReportedCost: z.boolean(),
  rawResponseDigest: z.string().max(128),
});

export const WORKER_HEARTBEAT = z.object({
  type: z.literal('heartbeat'),
});

export const WORKER_JOB_ACCEPT = z.object({
  type: z.literal('job_accept'),
  jobId: z.string(),
});

export const WORKER_JOB_DECLINE = z.object({
  type: z.literal('job_decline'),
  jobId: z.string(),
  reason: z.string().max(256).optional(),
});

export const WORKER_JOB_PROGRESS = z.object({
  type: z.literal('job_progress'),
  jobId: z.string(),
  message: z.string().max(2000),
});

export const WORKER_JOB_RESULT = z.object({
  type: z.literal('job_result'),
  jobId: z.string(),
  resultText: z.string(),
  outputFiles: z.array(JOB_FILE),
  tokenUsage: TOKEN_USAGE,
  attestation: ATTESTATION,
});

export const WORKER_JOB_FAILED = z.object({
  type: z.literal('job_failed'),
  jobId: z.string(),
  error: z.string().max(4000),
});

export const WorkerMessage = z.discriminatedUnion('type', [
  WORKER_REGISTER,
  WORKER_HEARTBEAT,
  WORKER_JOB_ACCEPT,
  WORKER_JOB_DECLINE,
  WORKER_JOB_PROGRESS,
  WORKER_JOB_RESULT,
  WORKER_JOB_FAILED,
]);
export type WorkerMessage = z.infer<typeof WorkerMessage>;

// --- Coordinator -> Worker -------------------------------------------------

export const COORD_REGISTERED = z.object({
  type: z.literal('registered'),
  workerId: z.string(),
});

export const COORD_JOB_OFFER = z.object({
  type: z.literal('job_offer'),
  job: z.object({
    id: z.string(),
    adapter: ADAPTER,
    prompt: z.string(),
    inputFiles: z.array(JOB_FILE),
    maxCredits: z.number().int().positive(),
  }),
});

export const COORD_JOB_CANCELLED = z.object({
  type: z.literal('job_cancelled'),
  jobId: z.string(),
});

export const COORD_ACK = z.object({
  type: z.literal('ack'),
  jobId: z.string(),
});

export const COORD_ERROR = z.object({
  type: z.literal('error'),
  message: z.string(),
});

export const CoordinatorMessage = z.discriminatedUnion('type', [
  COORD_REGISTERED,
  COORD_JOB_OFFER,
  COORD_JOB_CANCELLED,
  COORD_ACK,
  COORD_ERROR,
]);
export type CoordinatorMessage = z.infer<typeof CoordinatorMessage>;

/** Parse an inbound worker message, or return null if invalid. */
export function parseWorkerMessage(raw: string): WorkerMessage | null {
  try {
    return WorkerMessage.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Parse an inbound coordinator message, or return null if invalid. */
export function parseCoordinatorMessage(raw: string): CoordinatorMessage | null {
  try {
    return CoordinatorMessage.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
