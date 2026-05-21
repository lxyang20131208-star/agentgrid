// Worker reputation scoring.
//
// Reputation is a 0-100 score derived from a worker's lifetime record:
// jobs completed, jobs failed, and token-usage reports the coordinator
// flagged as implausible. It uses a Bayesian prior so a brand-new worker
// starts at a neutral score rather than a perfect or zero one, and so a
// worker with a handful of jobs is not judged too harshly or too generously.

export interface ReputationInput {
  jobsCompleted: number;
  jobsFailed: number;
  /** Token-usage reports the verifier flagged as implausible. */
  flaggedReports: number;
}

// Prior: pseudo-counts of "good" and "bad" outcomes added before any real
// history. ALPHA good + BETA bad => a new worker sits near 67/100.
const ALPHA = 2;
const BETA = 1;
// A flagged usage report counts as this many failures — dishonest metering
// is treated as worse than an honest failure.
const FLAG_WEIGHT = 2;

/** Compute a 0-100 reputation score. Higher is better. */
export function reputationScore(input: ReputationInput): number {
  const good = input.jobsCompleted;
  const bad = input.jobsFailed + FLAG_WEIGHT * input.flaggedReports;
  const score = (100 * (good + ALPHA)) / (good + bad + ALPHA + BETA);
  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Neutral score for a worker with no history — useful for display defaults. */
export function neutralReputation(): number {
  return reputationScore({ jobsCompleted: 0, jobsFailed: 0, flaggedReports: 0 });
}
