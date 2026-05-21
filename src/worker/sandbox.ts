// Worker sandboxing.
//
// A job's prompt runs inside a real coding agent on the worker's machine. A
// hostile prompt could try to read secrets or damage the system. The sandbox
// controls how the agent process is launched:
//
//   none        run directly with the full environment (trusted groups only)
//   restricted  run with an allowlisted environment — strips cloud creds, SSH
//               keys and unrelated API tokens so a prompt cannot exfiltrate
//               them via the agent. Does NOT isolate the filesystem.
//   container   run inside a `docker` container with the job workspace bind-
//               mounted, resource limits, dropped capabilities and no extra
//               privileges. This is the only mode that isolates the filesystem
//               and network.
//
// See docs/TRUST-AND-SECURITY.md.

import { run, type RunResult } from './adapters/exec.js';

export type SandboxMode = 'none' | 'restricted' | 'container';

export interface SandboxConfig {
  mode: SandboxMode;
  /** Container image for `container` mode (must have the agent CLIs). */
  containerImage?: string;
  /** Memory limit for `container` mode, e.g. "2g". */
  containerMemory?: string;
  /** CPU limit for `container` mode, e.g. "2". */
  containerCpus?: string;
  /** Docker network for `container` mode. Agents usually need "bridge". */
  containerNetwork?: string;
}

export interface SandboxRunOptions {
  /** Absolute path to the job workspace. */
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Sandbox {
  readonly mode: SandboxMode;
  /** Run a command under the sandbox policy. */
  run(command: string, args: string[], opts: SandboxRunOptions): Promise<RunResult>;
  /** Human-readable description of the active policy. */
  describe(): string;
}

// Environment variables a sandboxed agent is allowed to keep. Everything else
// is stripped in `restricted` and `container` mode. The allowlist is curated
// to include what coding agents need (their own API keys, locale, PATH/HOME)
// and nothing else.
const ENV_ALLOW_EXACT = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'TZ', 'PWD', 'NODE_PATH',
]);
const ENV_ALLOW_PREFIX = [
  'LC_', 'XDG_',
  'ANTHROPIC_', 'CLAUDE_',      // Claude Code
  'OPENAI_', 'CODEX_',          // Codex
];

function isAllowedEnvKey(key: string): boolean {
  if (ENV_ALLOW_EXACT.has(key)) return true;
  return ENV_ALLOW_PREFIX.some((prefix) => key.startsWith(prefix));
}

/** Build an environment containing only the allowlisted variables. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isAllowedEnvKey(key)) env[key] = value;
  }
  return env;
}

class NoneSandbox implements Sandbox {
  readonly mode = 'none' as const;
  run(command: string, args: string[], opts: SandboxRunOptions): Promise<RunResult> {
    return run(command, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  }
  describe(): string {
    return 'none — agent runs directly with the full environment';
  }
}

class RestrictedSandbox implements Sandbox {
  readonly mode = 'restricted' as const;
  run(command: string, args: string[], opts: SandboxRunOptions): Promise<RunResult> {
    return run(command, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      env: scrubbedEnv(),
    });
  }
  describe(): string {
    return 'restricted — environment scrubbed to an allowlist (no filesystem isolation)';
  }
}

class ContainerSandbox implements Sandbox {
  readonly mode = 'container' as const;
  constructor(private readonly cfg: Required<Omit<SandboxConfig, 'mode'>>) {}

  run(command: string, args: string[], opts: SandboxRunOptions): Promise<RunResult> {
    const dockerArgs = [
      'run', '--rm', '--init',
      '--volume', `${opts.cwd}:/workspace`,
      '--workdir', '/workspace',
      '--memory', this.cfg.containerMemory,
      '--cpus', this.cfg.containerCpus,
      '--network', this.cfg.containerNetwork,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '512',
    ];
    // Forward only allowlisted environment variables into the container.
    for (const key of Object.keys(process.env)) {
      if (isAllowedEnvKey(key) && !ENV_ALLOW_EXACT.has(key)) {
        dockerArgs.push('--env', key);
      }
    }
    dockerArgs.push(this.cfg.containerImage, command, ...args);

    return run('docker', dockerArgs, {
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
    });
  }

  describe(): string {
    return `container — docker image ${this.cfg.containerImage}, ${this.cfg.containerMemory} mem, ${this.cfg.containerCpus} cpu, network ${this.cfg.containerNetwork}`;
  }
}

/** Build a sandbox from configuration. */
export function createSandbox(config: SandboxConfig): Sandbox {
  switch (config.mode) {
    case 'none':
      return new NoneSandbox();
    case 'restricted':
      return new RestrictedSandbox();
    case 'container':
      return new ContainerSandbox({
        containerImage: config.containerImage ?? 'agentgrid-worker',
        containerMemory: config.containerMemory ?? '2g',
        containerCpus: config.containerCpus ?? '2',
        containerNetwork: config.containerNetwork ?? 'bridge',
      });
    default:
      throw new Error(`unknown sandbox mode: ${config.mode as string}`);
  }
}
