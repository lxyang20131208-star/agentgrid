// Conversion between provider USD cost, raw tokens, and AgentGrid credits.
//
// Credits are the network's internal unit of account. They are pegged to a
// fixed fraction of a US dollar so that "spend" and "earn" are symmetric and
// comparable across providers.

import type { AdapterName, TokenUsage } from './types.js';

/** 1 credit == USD_PER_CREDIT dollars. $1 == 10,000 credits. */
export const USD_PER_CREDIT = 0.0001;

/** Credits granted to each new account so the economy can bootstrap. */
export const DEFAULT_SIGNUP_GRANT = 10_000;

/** Default platform fee fraction taken from each settled job. */
export const DEFAULT_PLATFORM_FEE = 0;

export function usdToCredits(usd: number): number {
  return Math.max(0, Math.ceil(usd / USD_PER_CREDIT));
}

export function creditsToUsd(credits: number): number {
  return credits * USD_PER_CREDIT;
}

/** Per-model token pricing, in USD per 1M tokens. */
export interface TokenRate {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Fallback token rates for providers that do not report a USD cost directly.
 * These are deliberately approximate — a worker operator can override them.
 * Claude Code reports `total_cost_usd` itself, so it does not need an entry.
 */
export const DEFAULT_TOKEN_RATES: Record<AdapterName, TokenRate> = {
  'claude-code': { inputPerMTok: 3, outputPerMTok: 15 },
  'codex': { inputPerMTok: 2.5, outputPerMTok: 10 },
  'mock': { inputPerMTok: 1, outputPerMTok: 3 },
};

/** Estimate USD cost from raw token counts using a rate table. */
export function estimateCostUsd(
  rate: TokenRate,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * rate.inputPerMTok +
    (outputTokens / 1_000_000) * rate.outputPerMTok
  );
}

/** Convert a job's measured token usage into the credits a buyer is charged. */
export function usageToCredits(usage: TokenUsage): number {
  return usdToCredits(usage.costUsd);
}

/**
 * Settle a completed job between buyer, worker and platform.
 *
 * The buyer is charged the measured cost, capped at the escrowed budget.
 * The worker receives that amount minus the platform fee. Any unspent budget
 * is refunded to the buyer.
 */
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

export function computeSettlement(
  measuredCredits: number,
  escrowedCredits: number,
  platformFeeRate: number,
): Settlement {
  const cappedByBudget = measuredCredits > escrowedCredits;
  const charged = Math.min(measuredCredits, escrowedCredits);
  const platformFee = Math.floor(charged * platformFeeRate);
  const workerEarned = charged - platformFee;
  const refunded = escrowedCredits - charged;
  return { charged, workerEarned, platformFee, refunded, cappedByBudget };
}
