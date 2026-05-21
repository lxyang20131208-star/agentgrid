// Adapter registry and auto-detection.

import type { AdapterName } from '../../shared/types.js';
import type { AgentAdapter } from './types.js';
import { MockAdapter } from './mock.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';

export * from './types.js';

/** One instance of every adapter the worker knows how to drive. */
export function allAdapters(): AgentAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter(), new MockAdapter()];
}

export function getAdapter(name: AdapterName): AgentAdapter {
  const found = allAdapters().find((a) => a.name === name);
  if (!found) throw new Error(`unknown adapter: ${name}`);
  return found;
}

/**
 * Detect which adapters can actually run on this machine. `mock` is always
 * available; `claude-code` and `codex` depend on their CLIs being installed.
 */
export async function detectAvailableAdapters(): Promise<AdapterName[]> {
  const available: AdapterName[] = [];
  for (const adapter of allAdapters()) {
    if (await adapter.isAvailable()) available.push(adapter.name);
  }
  return available;
}
