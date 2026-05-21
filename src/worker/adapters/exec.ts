// Small process-spawning helper shared by the agent adapters.

import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface RunOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Text written to the child's stdin. */
  input?: string;
  env?: NodeJS.ProcessEnv;
}

/** Spawn a command and collect its output. Never rejects on a non-zero exit. */
export function run(
  command: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    };

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, opts.timeoutMs)
      : undefined;
    if (timer) timer.unref?.();

    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(127);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      finish(code ?? 0);
    });

    if (opts.input !== undefined) {
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
}

/** Return true if `<command> --version` exits cleanly within a short window. */
export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await run(command, ['--version'], { timeoutMs: 5_000 });
    return result.code === 0 && !result.timedOut;
  } catch {
    return false;
  }
}

/** Cheap, tokenizer-free token estimate (~4 characters per token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
