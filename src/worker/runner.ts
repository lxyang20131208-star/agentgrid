// Job runner: prepares an isolated workspace, drives an adapter, and collects
// the files the agent created or changed.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';
import type { JobFile, TokenUsage } from '../shared/types.js';
import type { AgentAdapter, SandboxedRun } from './adapters/index.js';
import type { Sandbox } from './sandbox.js';

export interface RunnerJob {
  id: string;
  prompt: string;
  inputFiles: JobFile[];
}

export interface RunnerResult {
  resultText: string;
  outputFiles: JobFile[];
  tokenUsage: TokenUsage;
}

export interface RunnerOptions {
  permissionMode: string;
  /** Sandbox policy used to launch the agent process. */
  sandbox: Sandbox;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

/** Max size of a single collected output file. */
const MAX_FILE_BYTES = 256 * 1024;
/** Max number of output files returned per job. */
const MAX_OUTPUT_FILES = 100;
/** Directory names never collected as output. */
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.agentgrid']);

/**
 * Run one job to completion inside a throwaway temp directory.
 *
 * The workspace is deleted afterwards regardless of success, so a buyer's
 * files never linger on a worker's disk.
 */
export async function runJob(
  adapter: AgentAdapter,
  job: RunnerJob,
  opts: RunnerOptions,
): Promise<RunnerResult> {
  const workdir = mkdtempSync(join(tmpdir(), 'agentgrid-job-'));
  try {
    // Materialise the buyer's input files.
    for (const file of job.inputFiles) {
      const safePath = sanitiseRelPath(file.path);
      const abs = join(workdir, safePath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, file.content);
    }
    const before = snapshot(workdir);

    // A sandbox-aware runner bound to this job's workspace. Adapters launch
    // the agent through this so the worker's sandbox policy is always applied.
    const sandboxedRun: SandboxedRun = (command, args, runOpts) =>
      opts.sandbox.run(command, args, {
        cwd: workdir,
        signal: runOpts?.signal,
        timeoutMs: runOpts?.timeoutMs,
      });

    opts.onProgress(`running ${adapter.name} (sandbox: ${opts.sandbox.mode})`);
    const result = await adapter.execute({
      prompt: job.prompt,
      workdir,
      permissionMode: opts.permissionMode,
      signal: opts.signal,
      run: sandboxedRun,
      onProgress: opts.onProgress,
    });

    const outputFiles = collectChangedFiles(workdir, before);
    return {
      resultText: result.resultText,
      outputFiles,
      tokenUsage: result.tokenUsage,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

/** Reject absolute paths and `..` traversal so input files stay in the workspace. */
function sanitiseRelPath(path: string): string {
  const normalised = path.replace(/\\/g, '/');
  const parts = normalised.split('/').filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) throw new Error(`invalid file path: ${path}`);
  return parts.join(sep);
}

/** Map of relative path -> content for every text file under `dir`. */
function snapshot(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rel of walk(dir)) {
    const content = readTextFile(join(dir, rel));
    if (content !== null) map.set(rel, content);
  }
  return map;
}

/** Files that are new or whose contents changed versus the input snapshot. */
function collectChangedFiles(
  dir: string,
  before: Map<string, string>,
): JobFile[] {
  const out: JobFile[] = [];
  for (const rel of walk(dir)) {
    if (out.length >= MAX_OUTPUT_FILES) break;
    const content = readTextFile(join(dir, rel));
    if (content === null) continue; // binary or oversized
    if (before.get(rel) === content) continue; // unchanged
    out.push({ path: rel.split(sep).join('/'), content });
  }
  return out;
}

/** Yield workspace-relative paths of every file under `dir`. */
function walk(dir: string): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string });
    const base = parent.parentPath ?? parent.path ?? dir;
    const abs = join(base, entry.name);
    const rel = relative(dir, abs);
    if (rel.split(sep).some((seg) => IGNORED_DIRS.has(seg))) continue;
    results.push(rel);
  }
  return results;
}

/** Read a file as UTF-8 text, or null if it is binary or too large. */
function readTextFile(abs: string): string | null {
  try {
    const buf = readFileSync(abs);
    if (buf.byteLength > MAX_FILE_BYTES) return null;
    if (buf.includes(0)) return null; // null byte => treat as binary
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
