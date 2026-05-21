// Adapter for Anthropic's Claude Code CLI (`claude`).
//
// Runs the agent non-interactively with `--output-format json`, which returns
// a result object that includes a `usage` block and `total_cost_usd`. Because
// Claude Code reports its own dollar cost, metering for this adapter is exact
// rather than estimated.

import { run, commandExists } from './exec.js';
import { makeUsage, type AgentAdapter, type ExecuteContext, type ExecuteResult } from './types.js';

/** Shape of the JSON object emitted by `claude -p --output-format json`. */
interface ClaudeResultJson {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code' as const;

  async isAvailable(): Promise<boolean> {
    return commandExists('claude');
  }

  async execute(ctx: ExecuteContext): Promise<ExecuteResult> {
    ctx.onProgress('claude-code: launching');

    const args = [
      '-p',
      ctx.prompt,
      '--output-format',
      'json',
      '--permission-mode',
      ctx.permissionMode,
    ];

    const res = await run('claude', args, {
      cwd: ctx.workdir,
      signal: ctx.signal,
      timeoutMs: 9 * 60_000,
    });

    if (res.timedOut) throw new Error('claude-code timed out');
    if (res.code !== 0 && !res.stdout.trim()) {
      throw new Error(`claude-code exited ${res.code}: ${res.stderr.slice(0, 500)}`);
    }

    let parsed: ClaudeResultJson;
    try {
      parsed = JSON.parse(res.stdout.trim());
    } catch {
      throw new Error(`claude-code: could not parse output: ${res.stdout.slice(0, 500)}`);
    }

    if (parsed.is_error) {
      throw new Error(`claude-code reported an error: ${parsed.result ?? 'unknown'}`);
    }

    const u = parsed.usage ?? {};
    const inputTokens = u.input_tokens ?? 0;
    const outputTokens = u.output_tokens ?? 0;
    const cacheCreationInputTokens = u.cache_creation_input_tokens ?? 0;
    const cacheReadInputTokens = u.cache_read_input_tokens ?? 0;

    ctx.onProgress('claude-code: complete');
    return {
      resultText: parsed.result ?? '',
      tokenUsage: makeUsage({
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cacheReadInputTokens,
        // Claude Code reports its own cost — trust it, don't estimate.
        costUsd: parsed.total_cost_usd ?? 0,
        estimated: parsed.total_cost_usd === undefined,
      }),
    };
  }
}
