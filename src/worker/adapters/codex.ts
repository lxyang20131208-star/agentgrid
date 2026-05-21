// Adapter for OpenAI's Codex CLI (`codex`).
//
// Runs `codex exec --json` non-interactively and parses the JSONL event
// stream. Codex's event schema has shifted across releases, so token usage is
// extracted defensively: any event carrying token-ish fields is accepted, and
// if none is found the adapter falls back to a character-based estimate.
//
// Because Codex does not report a dollar cost, cost is estimated from a
// configurable token-rate table (see shared/pricing.ts).

import { commandExists, estimateTokens } from './exec.js';
import { DEFAULT_TOKEN_RATES, estimateCostUsd } from '../../shared/pricing.js';
import {
  makeAttestation,
  makeUsage,
  type AgentAdapter,
  type ExecuteContext,
  type ExecuteResult,
} from './types.js';

interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Pull token counts out of an arbitrary Codex event object, if present. */
function extractUsage(obj: unknown): ParsedUsage | null {
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  // Usage may sit at the top level or under a `usage` / `info` key.
  const candidates = [rec, rec.usage, rec.info, rec.token_usage].filter(
    (c): c is Record<string, unknown> => !!c && typeof c === 'object',
  );
  for (const c of candidates) {
    const input =
      num(c.input_tokens) ?? num(c.prompt_tokens) ?? num(c.input);
    const output =
      num(c.output_tokens) ?? num(c.completion_tokens) ?? num(c.output);
    if (input !== null || output !== null) {
      return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
    }
  }
  return null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex' as const;

  async isAvailable(): Promise<boolean> {
    return commandExists('codex');
  }

  async execute(ctx: ExecuteContext): Promise<ExecuteResult> {
    ctx.onProgress('codex: launching');

    // `exec` is Codex's non-interactive mode. Flags are kept minimal because
    // their names vary by version; see docs/TRUST-AND-SECURITY.md.
    const args = ['exec', '--json', '--skip-git-repo-check', ctx.prompt];

    const res = await ctx.run('codex', args, {
      signal: ctx.signal,
      timeoutMs: 9 * 60_000,
    });

    if (res.timedOut) throw new Error('codex timed out');
    if (res.code !== 0 && !res.stdout.trim()) {
      throw new Error(`codex exited ${res.code}: ${res.stderr.slice(0, 500)}`);
    }

    // Parse the JSONL stream: keep the last usage seen and the last text body.
    let usage: ParsedUsage | null = null;
    let resultText = '';
    for (const line of res.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let event: unknown;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue; // non-JSON log line
      }
      const u = extractUsage(event);
      if (u) usage = u;
      const text = pickText(event);
      if (text) resultText = text;
    }

    if (!resultText) resultText = res.stdout.trim();

    const inputTokens = usage?.inputTokens ?? estimateTokens(ctx.prompt);
    const outputTokens = usage?.outputTokens ?? estimateTokens(resultText);
    const estimated = usage === null;
    const costUsd = estimateCostUsd(
      DEFAULT_TOKEN_RATES.codex,
      inputTokens,
      outputTokens,
    );

    ctx.onProgress('codex: complete');
    return {
      resultText,
      tokenUsage: makeUsage({ inputTokens, outputTokens, costUsd, estimated }),
      attestation: makeAttestation({
        provider: 'openai',
        model: null,
        // Codex does not report a dollar cost — AgentGrid estimates it.
        providerReportedCost: false,
        rawResponse: res.stdout,
      }),
    };
  }
}

/** Best-effort extraction of an assistant text body from a Codex event. */
function pickText(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const rec = event as Record<string, unknown>;
  for (const key of ['text', 'message', 'content', 'result', 'last_message']) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}
