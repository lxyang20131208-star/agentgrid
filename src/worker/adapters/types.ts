// The adapter contract. Each supported agent backend (Claude Code, Codex, the
// mock) implements this so the runner can treat them uniformly.

import type { AdapterName, TokenUsage } from '../../shared/types.js';
import type { RunResult } from './exec.js';

/**
 * A process runner that applies the worker's sandbox policy. Adapters MUST use
 * this to launch the agent rather than spawning processes directly — that is
 * what enforces sandboxing. The job workspace is the working directory.
 */
export type SandboxedRun = (
  command: string,
  args: string[],
  opts?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<RunResult>;

export interface ExecuteContext {
  /** The task prompt from the buyer. */
  prompt: string;
  /** Absolute path to the isolated workspace the agent should run in. */
  workdir: string;
  /** Permission mode for agents that support one (e.g. Claude Code). */
  permissionMode: string;
  /** Aborted when the job is cancelled or times out. */
  signal: AbortSignal;
  /** Sandbox-aware process runner — use this to launch the agent. */
  run: SandboxedRun;
  /** Called with human-readable progress lines. */
  onProgress: (message: string) => void;
}

export interface ExecuteResult {
  /** The agent's final textual answer. */
  resultText: string;
  /** Measured (or estimated) token + cost accounting. */
  tokenUsage: TokenUsage;
}

export interface AgentAdapter {
  readonly name: AdapterName;
  /** Whether this adapter can run on the current machine right now. */
  isAvailable(): Promise<boolean>;
  /** Run one job to completion. */
  execute(ctx: ExecuteContext): Promise<ExecuteResult>;
}

/** Build a fully-populated TokenUsage, filling defaults for missing fields. */
export function makeUsage(partial: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  costUsd: number;
  estimated: boolean;
}): TokenUsage {
  const cacheCreationInputTokens = partial.cacheCreationInputTokens ?? 0;
  const cacheReadInputTokens = partial.cacheReadInputTokens ?? 0;
  return {
    inputTokens: partial.inputTokens,
    outputTokens: partial.outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens:
      partial.inputTokens +
      partial.outputTokens +
      cacheCreationInputTokens +
      cacheReadInputTokens,
    costUsd: partial.costUsd,
    estimated: partial.estimated,
  };
}
