// Token-usage verification.
//
// Workers self-report how many tokens a job used and what it cost. A dishonest
// worker could inflate those numbers to earn more credits. The escrow budget
// already caps the buyer's worst case, but verification tightens that further:
// the coordinator independently bounds the worker's claim and charges the
// *verified* cost rather than the asserted one.
//
// What can actually be checked:
//   1. Absolute sanity — no job costs more than a hard ceiling per token, and
//      token counts cannot exceed a hard ceiling.
//   2. Cost-vs-tokens consistency — given the reported token counts and the
//      adapter's published rate table, the cost must fall within a tolerance.
//      Worker-estimated costs are clamped to this bound. Provider-attested
//      costs (Claude Code reports its own dollar figure) are trusted, subject
//      only to the absolute ceiling.
//   3. Floor — the report cannot claim drastically fewer tokens than the
//      prompt and result text obviously contain.

import type { AdapterName, TokenUsage } from './types.js';
import { DEFAULT_TOKEN_RATES, estimateCostUsd } from './pricing.js';

/** Hard ceiling on USD per token — nothing legitimate approaches this. */
const MAX_USD_PER_TOKEN = 0.001;
/** Hard ceiling on tokens for a single job. */
const MAX_TOKENS_PER_JOB = 50_000_000;
/** How far a worker-estimated cost may exceed the rate-table estimate. */
const COST_TOLERANCE = 2.0;
/** Characters-per-token floor divisor (very dense text is ~3-4 ch/token). */
const FLOOR_CHARS_PER_TOKEN = 12;

export interface UsageObservation {
  /** Total characters the worker was given (prompt + input files). */
  inputChars: number;
  /** Total characters the worker returned (result text + output files). */
  outputChars: number;
}

export interface UsageVerification {
  /** True when the report passed every check unchanged. */
  ok: boolean;
  /** The cost the coordinator should actually bill, in USD. */
  verifiedCostUsd: number;
  /** Human-readable reasons the report was adjusted or flagged. */
  reasons: string[];
}

/**
 * Verify a worker's token-usage report against what is independently
 * checkable. Returns the cost the coordinator should bill.
 */
export function verifyUsage(
  report: TokenUsage,
  adapter: AdapterName,
  observed: UsageObservation,
): UsageVerification {
  const reasons: string[] = [];
  let verifiedCostUsd = Math.max(0, report.costUsd);

  // 1. Absolute ceilings.
  if (report.totalTokens > MAX_TOKENS_PER_JOB) {
    reasons.push(
      `reported ${report.totalTokens} tokens exceeds the ${MAX_TOKENS_PER_JOB} per-job ceiling`,
    );
  }
  const absoluteCostCeiling = report.totalTokens * MAX_USD_PER_TOKEN;
  if (verifiedCostUsd > absoluteCostCeiling && report.totalTokens > 0) {
    reasons.push(
      `cost $${report.costUsd.toFixed(4)} exceeds the absolute ceiling $${absoluteCostCeiling.toFixed(4)}`,
    );
    verifiedCostUsd = absoluteCostCeiling;
  }

  // 2. Cost-vs-tokens consistency. Provider-attested costs are trusted; only
  //    worker-estimated costs are clamped to the rate-table bound.
  if (report.estimated) {
    const rate = DEFAULT_TOKEN_RATES[adapter];
    const rateEstimate = estimateCostUsd(
      rate,
      report.inputTokens + report.cacheCreationInputTokens + report.cacheReadInputTokens,
      report.outputTokens,
    );
    const plausibleMax = rateEstimate * COST_TOLERANCE;
    if (verifiedCostUsd > plausibleMax) {
      reasons.push(
        `estimated cost $${report.costUsd.toFixed(4)} exceeds the plausible bound $${plausibleMax.toFixed(4)} for ${report.totalTokens} tokens`,
      );
      verifiedCostUsd = plausibleMax;
    }
  }

  // 3. Token floor — the report cannot claim far fewer tokens than the text
  //    plainly contains. This does not change the bill (under-reporting only
  //    helps the buyer) but it is recorded for the worker's reputation.
  const floorTokens = Math.floor(
    (observed.inputChars + observed.outputChars) / FLOOR_CHARS_PER_TOKEN,
  );
  if (report.totalTokens > 0 && report.totalTokens < floorTokens) {
    reasons.push(
      `reported ${report.totalTokens} tokens is below the ${floorTokens}-token floor implied by the text`,
    );
  }

  return { ok: reasons.length === 0, verifiedCostUsd, reasons };
}
