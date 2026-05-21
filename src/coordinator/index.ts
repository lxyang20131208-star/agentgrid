// The coordinator: the broker that matches buyers' jobs to workers, runs the
// credit ledger, and settles payment when a job completes.
//
// It exposes an HTTP REST API for clients (see server.ts) and a WebSocket
// endpoint at /v1/worker for worker daemons.

import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  computeSettlement,
  DEFAULT_PLATFORM_FEE,
  DEFAULT_SIGNUP_GRANT,
  usdToCredits,
} from '../shared/pricing.js';
import {
  parseWorkerMessage,
  type CoordinatorMessage,
} from '../shared/protocol.js';
import { reputationScore } from '../shared/reputation.js';
import { verifyUsage } from '../shared/verification.js';
import type {
  AccountInfo,
  AdapterName,
  Job,
  JobFile,
  JobSpec,
  NetworkStats,
  PublicWorker,
  TokenUsage,
} from '../shared/types.js';
import { AgentGridDB, type User } from './db.js';
import { Ledger } from './ledger.js';
import { createHttpHandler } from './server.js';

export interface CoordinatorOptions {
  /** TCP port to listen on. 0 picks a free port (useful for tests). */
  port?: number;
  /** SQLite file path, or ':memory:' for an ephemeral database. */
  dbPath?: string;
  /** Credits granted to each new account. */
  signupGrant?: number;
  /** Platform fee fraction taken from each settled job. */
  platformFee?: number;
  /** Suppress console logging (used by tests). */
  quiet?: boolean;
}

/** How long a worker has to accept an offered job before it is re-routed. */
const OFFER_TIMEOUT_MS = 15_000;
/** How long a worker has to finish an accepted job before it is re-queued. */
const JOB_TIMEOUT_MS = 10 * 60_000;

interface LiveWorker {
  workerId: string;
  userId: string;
  ws: WebSocket;
  adapters: AdapterName[];
  /** The worker's advertised price: buyers pay measuredCost * this. */
  priceMultiplier: number;
  state: 'idle' | 'offered' | 'busy';
  jobId: string | null;
}

interface Offer {
  workerId: string;
  expiresAt: number;
}

interface RunningJob {
  workerId: string;
  expiresAt: number;
}

export class Coordinator {
  private readonly db: AgentGridDB;
  private readonly ledger: Ledger;
  private readonly signupGrant: number;
  private readonly platformFee: number;
  private readonly quiet: boolean;
  private readonly desiredPort: number;

  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  /** workerId -> live connection state. */
  private readonly live = new Map<string, LiveWorker>();
  /** jobId -> outstanding offer. */
  private readonly offers = new Map<string, Offer>();
  /** jobId -> running job tracking. */
  private readonly running = new Map<string, RunningJob>();
  /** "<jobId>|<workerId>" pairs a worker has declined or timed out on. */
  private readonly declined = new Set<string>();

  constructor(opts: CoordinatorOptions = {}) {
    this.db = new AgentGridDB(opts.dbPath ?? 'agentgrid.sqlite');
    this.ledger = new Ledger(this.db.raw);
    this.signupGrant = opts.signupGrant ?? DEFAULT_SIGNUP_GRANT;
    this.platformFee = opts.platformFee ?? DEFAULT_PLATFORM_FEE;
    this.quiet = opts.quiet ?? false;
    this.desiredPort = opts.port ?? 7420;
  }

  // --- Lifecycle -----------------------------------------------------------

  async start(): Promise<void> {
    const handler = createHttpHandler(this);
    this.http = createServer((req, res) => {
      void handler(req, res);
    });

    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/v1/worker') {
        socket.destroy();
        return;
      }
      const key = url.searchParams.get('key');
      const user = key ? this.authenticate(key) : null;
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => {
        this.handleWorkerSocket(ws, user);
      });
    });

    await new Promise<void>((resolve) => {
      this.http!.listen(this.desiredPort, () => resolve());
    });

    this.sweepTimer = setInterval(() => this.sweep(), 2_000);
    this.sweepTimer.unref();
    this.log(`coordinator listening on ${this.url}`);
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const lw of this.live.values()) lw.ws.close();
    this.live.clear();
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.http?.close(() => resolve());
    });
    this.db.close();
  }

  get port(): number {
    const addr = this.http?.address();
    if (addr && typeof addr === 'object') return addr.port;
    return this.desiredPort;
  }

  get url(): string {
    return `http://localhost:${this.port}`;
  }

  // --- Account / auth ------------------------------------------------------

  register(email: string): { user: User; apiKey: string } {
    if (this.db.getUserByEmail(email)) {
      throw new Error('email already registered');
    }
    const apiKey = `ag_${randomBytes(24).toString('hex')}`;
    const user = this.db.createUser(email, hashKey(apiKey));
    this.ledger.signupGrant(user.id, this.signupGrant);
    this.log(`registered ${email} (${user.id})`);
    return { user, apiKey };
  }

  authenticate(apiKey: string): User | null {
    return this.db.getUserByApiKeyHash(hashKey(apiKey));
  }

  getAccountInfo(userId: string): AccountInfo {
    const user = this.db.getUserById(userId);
    if (!user) throw new Error('user not found');
    return {
      userId: user.id,
      email: user.email,
      balance: this.ledger.userBalance(userId),
      escrowed: this.escrowedForBuyer(userId),
      createdAt: user.createdAt,
    };
  }

  private escrowedForBuyer(userId: string): number {
    // Credits the buyer currently has locked across in-flight jobs.
    let total = 0;
    for (const status of ['queued', 'assigned', 'running'] as const) {
      for (const job of this.db.listJobsByStatus(status)) {
        if (job.buyerId === userId) total += job.maxCredits;
      }
    }
    return total;
  }

  // --- Jobs ----------------------------------------------------------------

  submitJob(buyerId: string, spec: JobSpec): Job {
    const job = this.db.createJob(
      buyerId,
      spec.adapter,
      spec.prompt,
      spec.inputFiles,
      spec.maxCredits,
      spec.maxPriceMultiplier ?? null,
    );
    try {
      // Escrow the full budget up front so the worker is guaranteed payment.
      this.ledger.escrowForJob(job.id, buyerId, spec.maxCredits);
    } catch (err) {
      this.db.updateJob(job.id, { status: 'cancelled', error: 'escrow failed' });
      throw err;
    }
    this.log(`job ${job.id} queued by ${buyerId} (budget ${spec.maxCredits})`);
    this.dispatch();
    return this.db.getJob(job.id)!;
  }

  getJob(id: string): Job | null {
    return this.db.getJob(id);
  }

  listJobs(buyerId: string): Job[] {
    return this.db.listJobsByBuyer(buyerId);
  }

  // --- Workers (read) ------------------------------------------------------

  listPublicWorkers(): PublicWorker[] {
    return this.db.listWorkers().map((w) => ({
      id: w.id,
      name: w.name,
      adapters: w.adapters,
      status: this.live.has(w.id) ? w.status : 'offline',
      jobsCompleted: w.jobsCompleted,
      jobsFailed: w.jobsFailed,
      reputation: reputationScore({
        jobsCompleted: w.jobsCompleted,
        jobsFailed: w.jobsFailed,
        flaggedReports: w.flaggedReports,
      }),
      priceMultiplier: w.priceMultiplier,
      lastSeen: w.lastSeen,
    }));
  }

  /** Current 0-100 reputation score for a worker. */
  private workerReputation(workerId: string): number {
    const w = this.db.getWorker(workerId);
    if (!w) return 0;
    return reputationScore({
      jobsCompleted: w.jobsCompleted,
      jobsFailed: w.jobsFailed,
      flaggedReports: w.flaggedReports,
    });
  }

  getStats(): NetworkStats {
    return {
      users: this.db.countUsers(),
      workers: this.db.listWorkers().length,
      workersOnline: this.live.size,
      jobsQueued: this.db.countJobsByStatus('queued'),
      jobsRunning:
        this.db.countJobsByStatus('assigned') +
        this.db.countJobsByStatus('running'),
      jobsCompleted: this.db.countJobsByStatus('completed'),
      creditsInCirculation: this.ledger.creditsInCirculation(),
      totalTokensMetered: this.db.totalTokensMetered(),
    };
  }

  // --- Worker WebSocket ----------------------------------------------------

  private handleWorkerSocket(ws: WebSocket, user: User): void {
    let workerId: string | null = null;

    ws.on('message', (data) => {
      const msg = parseWorkerMessage(data.toString());
      if (!msg) {
        send(ws, { type: 'error', message: 'malformed message' });
        return;
      }

      if (msg.type === 'register') {
        const priceMultiplier = msg.priceMultiplier ?? 1;
        const worker = this.db.upsertWorker(
          user.id,
          msg.name,
          msg.adapters,
          priceMultiplier,
        );
        workerId = worker.id;
        this.live.set(worker.id, {
          workerId: worker.id,
          userId: user.id,
          ws,
          adapters: msg.adapters,
          priceMultiplier,
          state: 'idle',
          jobId: null,
        });
        this.db.setWorkerStatus(worker.id, 'idle');
        send(ws, { type: 'registered', workerId: worker.id });
        this.log(`worker ${worker.name} online (${worker.id}) @ ${priceMultiplier}x`);
        this.dispatch();
        return;
      }

      if (!workerId || !this.live.has(workerId)) {
        send(ws, { type: 'error', message: 'register first' });
        return;
      }
      const lw = this.live.get(workerId)!;

      switch (msg.type) {
        case 'heartbeat':
          this.db.setWorkerStatus(lw.workerId, lw.state === 'idle' ? 'idle' : 'busy');
          break;
        case 'job_accept':
          this.onJobAccept(lw, msg.jobId);
          break;
        case 'job_decline':
          this.onJobDecline(lw, msg.jobId);
          break;
        case 'job_progress':
          this.onJobProgress(lw, msg.jobId);
          break;
        case 'job_result':
          this.onJobResult(lw, msg.jobId, msg.resultText, msg.outputFiles, msg.tokenUsage);
          break;
        case 'job_failed':
          this.onJobFailed(lw, msg.jobId, msg.error);
          break;
      }
    });

    ws.on('close', () => {
      if (workerId) this.handleWorkerGone(workerId);
    });
    ws.on('error', () => {
      if (workerId) this.handleWorkerGone(workerId);
    });
  }

  private handleWorkerGone(workerId: string): void {
    const lw = this.live.get(workerId);
    if (!lw) return;
    this.live.delete(workerId);
    this.db.setWorkerStatus(workerId, 'offline');
    this.log(`worker ${workerId} offline`);

    // Any job this worker held goes back into the queue for someone else.
    if (lw.jobId) {
      this.offers.delete(lw.jobId);
      this.running.delete(lw.jobId);
      // Abandoning a job mid-flight counts against the worker's reputation.
      if (lw.state === 'busy') this.db.recordWorkerFailure(workerId);
      const job = this.db.getJob(lw.jobId);
      if (job && (job.status === 'queued' || job.status === 'assigned' || job.status === 'running')) {
        this.db.updateJob(lw.jobId, { status: 'queued', workerId: null });
        this.log(`job ${lw.jobId} re-queued (worker left)`);
      }
    }
    this.dispatch();
  }

  // --- Job lifecycle handlers ---------------------------------------------

  private onJobAccept(lw: LiveWorker, jobId: string): void {
    const offer = this.offers.get(jobId);
    if (!offer || offer.workerId !== lw.workerId || lw.jobId !== jobId) {
      // Stale or unsolicited accept — ignore.
      return;
    }
    this.offers.delete(jobId);
    lw.state = 'busy';
    this.db.setWorkerStatus(lw.workerId, 'busy');
    this.db.updateJob(jobId, { status: 'assigned', workerId: lw.workerId });
    this.running.set(jobId, {
      workerId: lw.workerId,
      expiresAt: Date.now() + JOB_TIMEOUT_MS,
    });
    this.log(`job ${jobId} accepted by ${lw.workerId}`);
  }

  private onJobDecline(lw: LiveWorker, jobId: string): void {
    const offer = this.offers.get(jobId);
    if (!offer || offer.workerId !== lw.workerId) return;
    this.offers.delete(jobId);
    this.declined.add(`${jobId}|${lw.workerId}`);
    this.freeWorker(lw);
    this.dispatch();
  }

  private onJobProgress(lw: LiveWorker, jobId: string): void {
    if (lw.jobId !== jobId) return;
    if (this.db.getJob(jobId)?.status === 'assigned') {
      this.db.updateJob(jobId, { status: 'running' });
    }
  }

  private onJobResult(
    lw: LiveWorker,
    jobId: string,
    resultText: string,
    outputFiles: JobFile[],
    tokenUsage: TokenUsage,
  ): void {
    if (lw.jobId !== jobId) return; // stale result for a re-queued job
    const job = this.db.getJob(jobId);
    if (!job) return;

    // 1. Verify the worker's token-usage report. The coordinator bills the
    //    verified cost, not the asserted one.
    const verification = verifyUsage(tokenUsage, job.adapter, {
      inputChars: job.prompt.length + sumChars(job.inputFiles),
      outputChars: resultText.length + sumChars(outputFiles),
    });

    // 2. Apply the worker's price multiplier on top of the verified cost.
    const measuredCredits = usdToCredits(verification.verifiedCostUsd);
    const pricedCredits = Math.max(
      0,
      Math.ceil(measuredCredits * lw.priceMultiplier),
    );
    const settlement = computeSettlement(
      pricedCredits,
      job.maxCredits,
      this.platformFee,
    );

    // 3. Settle the ledger and update worker stats.
    const workerInfo = this.db.getWorker(lw.workerId);
    if (workerInfo) {
      this.ledger.settleJob(
        jobId,
        job.buyerId,
        workerInfo.userId,
        job.maxCredits,
        settlement,
      );
      this.db.recordWorkerCompletion(lw.workerId, settlement.workerEarned);
      if (!verification.ok) {
        this.db.recordWorkerFlag(lw.workerId);
        this.log(`job ${jobId} usage flagged: ${verification.reasons.join('; ')}`);
      }
    }

    this.db.updateJob(jobId, {
      status: 'completed',
      resultText,
      outputFiles,
      tokenUsage,
      costCredits: settlement.charged,
      verification,
    });
    this.running.delete(jobId);
    this.declined.delete(`${jobId}|${lw.workerId}`);
    this.log(
      `job ${jobId} completed — charged ${settlement.charged}, worker earned ${settlement.workerEarned}`,
    );
    this.freeWorker(lw);
    this.dispatch();
  }

  private onJobFailed(lw: LiveWorker, jobId: string, error: string): void {
    if (lw.jobId !== jobId) return;
    const job = this.db.getJob(jobId);
    if (job && job.status !== 'completed' && job.status !== 'failed') {
      this.ledger.refundJob(jobId, job.buyerId, job.maxCredits);
      this.db.updateJob(jobId, { status: 'failed', error });
      this.db.recordWorkerFailure(lw.workerId);
      this.log(`job ${jobId} failed: ${error}`);
    }
    this.running.delete(jobId);
    this.freeWorker(lw);
    this.dispatch();
  }

  private freeWorker(lw: LiveWorker): void {
    lw.state = 'idle';
    lw.jobId = null;
    if (this.live.has(lw.workerId)) this.db.setWorkerStatus(lw.workerId, 'idle');
  }

  // --- Matching ------------------------------------------------------------

  private dispatch(): void {
    for (const job of this.db.listJobsByStatus('queued')) {
      if (this.offers.has(job.id)) continue;
      const worker = this.findWorkerFor(job);
      if (!worker) continue;
      this.offerJob(job, worker);
    }
  }

  /**
   * Pick the best worker for a job. Eligible workers are idle, offer the
   * requested adapter, have not declined the job, and price themselves within
   * the buyer's limit. Among those, the cheapest wins; reputation breaks ties.
   * This is the network's price-competition mechanism.
   */
  private findWorkerFor(job: Job): LiveWorker | null {
    const eligible: { lw: LiveWorker; reputation: number }[] = [];
    for (const lw of this.live.values()) {
      if (lw.state !== 'idle') continue;
      if (!lw.adapters.includes(job.adapter)) continue;
      if (this.declined.has(`${job.id}|${lw.workerId}`)) continue;
      if (
        job.maxPriceMultiplier !== undefined &&
        lw.priceMultiplier > job.maxPriceMultiplier
      ) {
        continue;
      }
      eligible.push({ lw, reputation: this.workerReputation(lw.workerId) });
    }
    if (eligible.length === 0) return null;
    eligible.sort(
      (a, b) =>
        a.lw.priceMultiplier - b.lw.priceMultiplier ||
        b.reputation - a.reputation,
    );
    return eligible[0]!.lw;
  }

  private offerJob(job: Job, worker: LiveWorker): void {
    worker.state = 'offered';
    worker.jobId = job.id;
    this.offers.set(job.id, {
      workerId: worker.workerId,
      expiresAt: Date.now() + OFFER_TIMEOUT_MS,
    });
    send(worker.ws, {
      type: 'job_offer',
      job: {
        id: job.id,
        adapter: job.adapter,
        prompt: job.prompt,
        inputFiles: job.inputFiles,
        maxCredits: job.maxCredits,
      },
    });
    this.log(`offered job ${job.id} to ${worker.workerId}`);
  }

  /** Periodic sweep: expire stale offers and re-queue stuck jobs. */
  private sweep(): void {
    const now = Date.now();
    for (const [jobId, offer] of this.offers) {
      if (offer.expiresAt > now) continue;
      this.offers.delete(jobId);
      this.declined.add(`${jobId}|${offer.workerId}`);
      const lw = this.live.get(offer.workerId);
      if (lw && lw.jobId === jobId) this.freeWorker(lw);
      this.log(`offer for job ${jobId} expired`);
    }
    for (const [jobId, run] of this.running) {
      if (run.expiresAt > now) continue;
      this.running.delete(jobId);
      this.declined.add(`${jobId}|${run.workerId}`);
      const lw = this.live.get(run.workerId);
      if (lw && lw.jobId === jobId) this.freeWorker(lw);
      const job = this.db.getJob(jobId);
      if (job && (job.status === 'assigned' || job.status === 'running')) {
        this.db.updateJob(jobId, { status: 'queued', workerId: null });
        this.db.recordWorkerFailure(run.workerId);
        this.log(`job ${jobId} timed out — re-queued`);
      }
    }
    if (this.offers.size === 0 && this.running.size === 0) {
      // Nothing pending; opportunistically match anything still queued.
    }
    this.dispatch();
  }

  private log(msg: string): void {
    if (!this.quiet) console.log(`[coordinator] ${msg}`);
  }
}

function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function sumChars(files: JobFile[]): number {
  return files.reduce((n, f) => n + f.content.length, 0);
}

function send(ws: WebSocket, msg: CoordinatorMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
