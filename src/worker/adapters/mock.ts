// A deterministic, dependency-free adapter.
//
// It runs no real model, so the whole network — coordinator, worker, ledger,
// settlement — can be exercised end-to-end in tests, CI and demos without an
// API key or any token spend. Token usage is synthesised from the prompt size
// so credit accounting still has realistic-looking numbers to move around.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokens } from './exec.js';
import { DEFAULT_TOKEN_RATES, estimateCostUsd } from '../../shared/pricing.js';
import { makeUsage, type AgentAdapter, type ExecuteContext, type ExecuteResult } from './types.js';

export class MockAdapter implements AgentAdapter {
  readonly name = 'mock' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(ctx: ExecuteContext): Promise<ExecuteResult> {
    ctx.onProgress('mock adapter: starting');

    const resultText = [
      `[mock] Received task: ${ctx.prompt.slice(0, 200)}`,
      `[mock] Workspace contained the input files; wrote MOCK_RESULT.md.`,
      `[mock] A real adapter (claude-code, codex) would do the actual work here.`,
    ].join('\n');

    // Leave an artefact so output-file collection has something to return.
    writeFileSync(
      join(ctx.workdir, 'MOCK_RESULT.md'),
      `# Mock result\n\nPrompt:\n\n${ctx.prompt}\n`,
    );

    const inputTokens = estimateTokens(ctx.prompt);
    const outputTokens = estimateTokens(resultText);
    const rate = DEFAULT_TOKEN_RATES.mock;
    const costUsd = estimateCostUsd(rate, inputTokens, outputTokens);

    ctx.onProgress('mock adapter: done');
    return {
      resultText,
      tokenUsage: makeUsage({ inputTokens, outputTokens, costUsd, estimated: true }),
    };
  }
}
