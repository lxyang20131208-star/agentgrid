// The worker daemon.
//
// Connects to a coordinator over WebSocket, advertises which agent adapters it
// can run, accepts offered jobs, executes them locally, and reports the result
// plus measured token usage. The worker's own API credentials never leave this
// machine — only the task prompt, input files and result travel the network.

import { WebSocket } from 'ws';
import {
  parseCoordinatorMessage,
  type WorkerMessage,
} from '../shared/protocol.js';
import type { AdapterName } from '../shared/types.js';
import { allAdapters, detectAvailableAdapters, getAdapter } from './adapters/index.js';
import { runJob } from './runner.js';

export interface WorkerOptions {
  coordinatorUrl: string;
  apiKey: string;
  name: string;
  /** Adapters to offer. Omit to auto-detect what is installed. */
  adapters?: AdapterName[];
  /** Permission mode passed to agents that support one. */
  permissionMode?: string;
  /** Suppress console logging (used by tests). */
  quiet?: boolean;
  /** Reconnect automatically when the connection drops. Default true. */
  autoReconnect?: boolean;
}

export class Worker {
  private ws: WebSocket | null = null;
  private workerId: string | null = null;
  private busy = false;
  private stopped = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private currentAbort: AbortController | null = null;
  private adapters: AdapterName[] = [];
  private readonly permissionMode: string;
  private readonly autoReconnect: boolean;
  private registeredResolvers: Array<() => void> = [];

  constructor(private readonly opts: WorkerOptions) {
    this.permissionMode = opts.permissionMode ?? 'acceptEdits';
    this.autoReconnect = opts.autoReconnect ?? true;
  }

  /** Connect and resolve once the coordinator has acknowledged registration. */
  async start(): Promise<void> {
    this.adapters =
      this.opts.adapters && this.opts.adapters.length > 0
        ? this.opts.adapters
        : await detectAvailableAdapters();
    if (this.adapters.length === 0) {
      throw new Error('no agent adapters available on this machine');
    }
    this.log(`offering adapters: ${this.adapters.join(', ')}`);

    const registered = new Promise<void>((resolve) => {
      this.registeredResolvers.push(resolve);
    });
    this.connect();
    await registered;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.currentAbort?.abort();
    await new Promise<void>((resolve) => {
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.close();
    });
  }

  get id(): string | null {
    return this.workerId;
  }

  // --- Connection ----------------------------------------------------------

  private connect(): void {
    const url = `${toWsUrl(this.opts.coordinatorUrl)}?key=${encodeURIComponent(this.opts.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.send({ type: 'register', name: this.opts.name, adapters: this.adapters });
      this.heartbeat = setInterval(() => this.send({ type: 'heartbeat' }), 20_000);
      this.heartbeat.unref();
    });

    ws.on('message', (data) => {
      void this.handleMessage(data.toString());
    });

    ws.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.workerId = null;
      if (this.stopped || !this.autoReconnect) return;
      this.log('disconnected — reconnecting in 3s');
      setTimeout(() => {
        if (!this.stopped) this.connect();
      }, 3_000).unref();
    });

    ws.on('error', (err) => {
      this.log(`socket error: ${err.message}`);
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    const msg = parseCoordinatorMessage(raw);
    if (!msg) return;

    switch (msg.type) {
      case 'registered':
        this.workerId = msg.workerId;
        this.log(`registered as ${msg.workerId}`);
        for (const resolve of this.registeredResolvers.splice(0)) resolve();
        break;
      case 'job_offer':
        await this.handleOffer(msg.job);
        break;
      case 'job_cancelled':
        this.currentAbort?.abort();
        break;
      case 'error':
        this.log(`coordinator error: ${msg.message}`);
        break;
      case 'ack':
        break;
    }
  }

  // --- Job execution -------------------------------------------------------

  private async handleOffer(job: {
    id: string;
    adapter: AdapterName;
    prompt: string;
    inputFiles: { path: string; content: string }[];
    maxCredits: number;
  }): Promise<void> {
    if (this.busy) {
      this.send({ type: 'job_decline', jobId: job.id, reason: 'worker busy' });
      return;
    }
    if (!this.adapters.includes(job.adapter)) {
      this.send({ type: 'job_decline', jobId: job.id, reason: 'adapter not offered' });
      return;
    }

    this.busy = true;
    this.send({ type: 'job_accept', jobId: job.id });
    this.log(`accepted job ${job.id} (${job.adapter})`);

    const abort = new AbortController();
    this.currentAbort = abort;
    try {
      const adapter = getAdapter(job.adapter);
      const result = await runJob(
        adapter,
        { id: job.id, prompt: job.prompt, inputFiles: job.inputFiles },
        {
          permissionMode: this.permissionMode,
          signal: abort.signal,
          onProgress: (message) =>
            this.send({ type: 'job_progress', jobId: job.id, message }),
        },
      );
      this.send({
        type: 'job_result',
        jobId: job.id,
        resultText: result.resultText,
        outputFiles: result.outputFiles,
        tokenUsage: result.tokenUsage,
      });
      this.log(
        `job ${job.id} done — ${result.tokenUsage.totalTokens} tokens, $${result.tokenUsage.costUsd.toFixed(4)}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.send({ type: 'job_failed', jobId: job.id, error: message });
      this.log(`job ${job.id} failed: ${message}`);
    } finally {
      this.busy = false;
      this.currentAbort = null;
    }
  }

  private send(msg: WorkerMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private log(msg: string): void {
    if (!this.opts.quiet) console.log(`[worker] ${msg}`);
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
