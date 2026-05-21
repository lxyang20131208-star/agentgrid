// The worker daemon.
//
// A worker lends a machine's agent compute. It can:
//   - run several jobs at once (capacity > 1), and
//   - connect to several coordinators at once (federation / multi-homing),
//     with one shared capacity budget across all of them.
//
// The worker's own API credentials never leave this machine — only the task
// prompt, input files and result travel the network.

import { WebSocket } from 'ws';
import {
  parseCoordinatorMessage,
  type WorkerMessage,
} from '../shared/protocol.js';
import type { AdapterName } from '../shared/types.js';
import { allAdapters, detectAvailableAdapters, getAdapter } from './adapters/index.js';
import { runJob } from './runner.js';
import { createSandbox, type Sandbox, type SandboxConfig } from './sandbox.js';

export interface WorkerOptions {
  /** One or more coordinators to connect to (multi-homing). */
  coordinatorUrls: string[];
  apiKey: string;
  name: string;
  /** Adapters to offer. Omit to auto-detect what is installed. */
  adapters?: AdapterName[];
  /** Permission mode passed to agents that support one. */
  permissionMode?: string;
  /** The worker's price: buyers pay measuredCost * priceMultiplier. Default 1. */
  priceMultiplier?: number;
  /** Maximum jobs to run concurrently, across all coordinators. Default 1. */
  capacity?: number;
  /** Sandbox policy for running jobs. Default { mode: 'none' }. */
  sandbox?: SandboxConfig;
  /** Suppress console logging (used by tests). */
  quiet?: boolean;
  /** Reconnect automatically when a connection drops. Default true. */
  autoReconnect?: boolean;
}

interface OfferedJob {
  id: string;
  adapter: AdapterName;
  prompt: string;
  inputFiles: { path: string; content: string }[];
  maxCredits: number;
}

export class Worker {
  private readonly links: CoordinatorLink[] = [];
  /** Job ids currently running — shared across every coordinator link. */
  private readonly activeJobs = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();

  private adapters: AdapterName[] = [];
  private readonly permissionMode: string;
  private readonly priceMultiplier: number;
  private readonly capacity: number;
  private readonly sandbox: Sandbox;
  private readonly autoReconnect: boolean;

  constructor(private readonly opts: WorkerOptions) {
    this.permissionMode = opts.permissionMode ?? 'acceptEdits';
    this.priceMultiplier = opts.priceMultiplier ?? 1;
    this.capacity = Math.max(1, opts.capacity ?? 1);
    this.sandbox = createSandbox(opts.sandbox ?? { mode: 'none' });
    this.autoReconnect = opts.autoReconnect ?? true;
  }

  /** Connect to every coordinator and resolve once each has been reached. */
  async start(): Promise<void> {
    this.adapters =
      this.opts.adapters && this.opts.adapters.length > 0
        ? this.opts.adapters
        : await detectAvailableAdapters();
    if (this.adapters.length === 0) {
      throw new Error('no agent adapters available on this machine');
    }
    if (this.opts.coordinatorUrls.length === 0) {
      throw new Error('no coordinator URLs given');
    }
    this.log(`offering adapters: ${this.adapters.join(', ')}`);
    this.log(
      `price ${this.priceMultiplier}x · capacity ${this.capacity} · sandbox ${this.sandbox.mode}`,
    );

    for (const url of this.opts.coordinatorUrls) {
      const link = new CoordinatorLink(
        url,
        this,
        this.autoReconnect,
        this.opts.apiKey,
      );
      this.links.push(link);
      link.connect();
    }
    // Resolve once every link has either registered or had a failed attempt,
    // so an unreachable coordinator does not hang startup.
    await Promise.all(this.links.map((l) => l.firstAttempt));
  }

  async stop(): Promise<void> {
    for (const abort of this.aborts.values()) abort.abort();
    await Promise.all(this.links.map((l) => l.close()));
  }

  /** The worker id assigned by the first coordinator (for tests). */
  get id(): string | null {
    return this.links[0]?.workerId ?? null;
  }

  /** Worker ids assigned by each coordinator, in connection order. */
  get ids(): (string | null)[] {
    return this.links.map((l) => l.workerId);
  }

  // --- Shared config exposed to links --------------------------------------

  get registration(): { name: string; adapters: AdapterName[]; priceMultiplier: number; capacity: number } {
    return {
      name: this.opts.name,
      adapters: this.adapters,
      priceMultiplier: this.priceMultiplier,
      capacity: this.capacity,
    };
  }

  get quiet(): boolean {
    return this.opts.quiet ?? false;
  }

  // --- Job handling --------------------------------------------------------

  /**
   * Decide on an offered job and, if accepted, run it. Capacity is checked
   * synchronously so concurrent offers cannot over-commit the worker.
   */
  async handleOffer(link: CoordinatorLink, job: OfferedJob): Promise<void> {
    if (!this.adapters.includes(job.adapter)) {
      link.send({ type: 'job_decline', jobId: job.id, reason: 'adapter not offered' });
      return;
    }
    if (this.activeJobs.size >= this.capacity) {
      link.send({ type: 'job_decline', jobId: job.id, reason: 'at capacity' });
      return;
    }

    this.activeJobs.add(job.id);
    link.send({ type: 'job_accept', jobId: job.id });
    this.log(`accepted job ${job.id} (${job.adapter}) [${this.activeJobs.size}/${this.capacity}]`);

    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    try {
      const adapter = getAdapter(job.adapter);
      const result = await runJob(
        adapter,
        { id: job.id, prompt: job.prompt, inputFiles: job.inputFiles },
        {
          permissionMode: this.permissionMode,
          sandbox: this.sandbox,
          signal: abort.signal,
          onProgress: (message) =>
            link.send({ type: 'job_progress', jobId: job.id, message }),
        },
      );
      link.send({
        type: 'job_result',
        jobId: job.id,
        resultText: result.resultText,
        outputFiles: result.outputFiles,
        tokenUsage: result.tokenUsage,
        attestation: result.attestation,
      });
      this.log(
        `job ${job.id} done — ${result.tokenUsage.totalTokens} tokens, $${result.tokenUsage.costUsd.toFixed(4)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      link.send({ type: 'job_failed', jobId: job.id, error: message });
      this.log(`job ${job.id} failed: ${message}`);
    } finally {
      this.activeJobs.delete(job.id);
      this.aborts.delete(job.id);
    }
  }

  /** Abort a running job (coordinator cancelled it). */
  cancelJob(jobId: string): void {
    this.aborts.get(jobId)?.abort();
  }

  log(msg: string): void {
    if (!this.quiet) console.log(`[worker] ${msg}`);
  }
}

/**
 * One WebSocket connection to one coordinator. Several of these can be live at
 * once; they all share the parent Worker's capacity and adapters.
 */
class CoordinatorLink {
  workerId: string | null = null;
  /** Resolves after the first connection attempt settles (success or fail). */
  readonly firstAttempt: Promise<void>;
  private settleFirstAttempt!: () => void;
  private firstAttemptDone = false;

  private ws: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly url: string,
    private readonly worker: Worker,
    private readonly autoReconnect: boolean,
    private readonly apiKey: string,
  ) {
    this.firstAttempt = new Promise<void>((resolve) => {
      this.settleFirstAttempt = resolve;
    });
  }

  connect(): void {
    const wsUrl = `${toWsUrl(this.url)}?key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      const reg = this.worker.registration;
      this.send({
        type: 'register',
        name: reg.name,
        adapters: reg.adapters,
        priceMultiplier: reg.priceMultiplier,
        capacity: reg.capacity,
      });
      this.heartbeat = setInterval(() => this.send({ type: 'heartbeat' }), 20_000);
      this.heartbeat.unref();
    });

    ws.on('message', (data) => {
      void this.handleMessage(data.toString());
    });

    ws.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.workerId = null;
      this.markFirstAttempt();
      if (this.stopped || !this.autoReconnect) return;
      this.worker.log(`${this.url}: disconnected — reconnecting in 3s`);
      setTimeout(() => {
        if (!this.stopped) this.connect();
      }, 3_000).unref();
    });

    ws.on('error', (err) => {
      this.worker.log(`${this.url}: socket error: ${err.message}`);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    const msg = parseCoordinatorMessage(raw);
    if (!msg) return;
    switch (msg.type) {
      case 'registered':
        this.workerId = msg.workerId;
        this.worker.log(`${this.url}: registered as ${msg.workerId}`);
        this.markFirstAttempt();
        break;
      case 'job_offer':
        await this.worker.handleOffer(this, msg.job);
        break;
      case 'job_cancelled':
        this.worker.cancelJob(msg.jobId);
        break;
      case 'error':
        this.worker.log(`${this.url}: coordinator error: ${msg.message}`);
        break;
      case 'ack':
        break;
    }
  }

  private markFirstAttempt(): void {
    if (this.firstAttemptDone) return;
    this.firstAttemptDone = true;
    this.settleFirstAttempt();
  }

  send(msg: WorkerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    return new Promise<void>((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }
}

/** Report adapter availability without connecting to a coordinator. */
export async function probeAdapters(): Promise<Record<AdapterName, boolean>> {
  const result = {} as Record<AdapterName, boolean>;
  for (const adapter of allAdapters()) {
    result[adapter.name] = await adapter.isAvailable();
  }
  return result;
}

function toWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/v1/worker';
  u.search = '';
  return u.toString();
}
