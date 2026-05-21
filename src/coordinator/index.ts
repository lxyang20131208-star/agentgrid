// The coordinator: the broker that matches buyers' jobs to workers, runs the
// credit ledger, verifies results and settles payment.
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
import { checkResult, isResultUsable } from '../shared/result-check.js';
import type {
  AccountInfo,
  AdapterName,
  Attestation,
  Job,
  JobFile,
  JobSpec,
  NetworkStats,
  PublicWorker,
  Resolution,
  Settlement,
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
  /**
   * How long a buyer may accept or dispute a delivered job before it auto-
   * settles, in milliseconds. 0 (the default) settles immediately on result
   * and disables disputes.
   */
  acceptanceWindowMs?: number;
  /** Admin key for arbitration. Generated and logged if omitted. */
  adminKey?: string;
  /** Peer coordinator URLs for the federated view. */
  peers?: string[];
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
  priceMultiplier: number;
  capacity: number;
  /** Job ids currently offered to or running on this worker. */
  jobs: Set<string>;
}

interface Pending {
  workerId: string;
  expiresAt: number;
}

export class Coordinator {
  private readonly db: AgentGridDB;
  private readonly ledger: Ledger;
  private readonly signupGrant: number;
  private readonly platformFee: number;
  private readonly acceptanceWindowMs: number;
  private readonly peers: string[];
  private readonly quiet: boolean;
  private readonly desiredPort: number;
  readonly adminKey: string;

  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  private readonly live = new Map<string, LiveWorker>();
  private readonly offers = new Map<string, Pending>();
  private readonly running = new Map<string, Pending>();
  private readonly declined = new Set<string>();

  constructor(opts: CoordinatorOptions = {}) {
    this.db = new AgentGridDB(opts.dbPath ?? 'agentgrid.sqlite');
    this.ledger = new Ledger(this.db.raw);
    this.signupGrant = opts.signupGrant ?? DEFAULT_SIGNUP_GRANT;
    this.platformFee = opts.platformFee ?? DEFAULT_PLATFORM_FEE;
    this.acceptanceWindowMs = Math.max(0, opts.acceptanceWindowMs ?? 0);
    this.peers = opts.peers ?? [];
    this.quiet = opts.quiet ?? false;
    this.desiredPort = opts.port ?? 7420;
    this.adminKey = opts.adminKey ?? `ag_admin_${randomBytes(18).toString('hex')}`;
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
    if (this.acceptanceWindowMs > 0) {
      this.log(`acceptance window: ${this.acceptanceWindowMs}ms · admin key: ${this.adminKey}`);
    }
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const lw of this.live.values()) lw.ws.close();
    this.live.clear();
    await new Promise<void>((resolve) => this.wss?.close(() => resolve()));
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
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

  authenticateAdmin(key: string | null): boolean {
    return key !== null && key === this.adminKey;
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
    let total = 0;
    for (const status of ['queued', 'assigned', 'running', 'delivered', 'disputed'] as const) {
      for (const job of this.db.listJobsByStatus(status)) {
        if (job.buyerId === userId) total += job.maxCredits;
      }
    }
    return total;
  }

  // --- Jobs (buyer side) ---------------------------------------------------

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

  /** Buyer accepts a delivered job — the worker is paid immediately. */
  acceptJob(buyerId: string, jobId: string): Job {
    const job = this.requireBuyerJob(buyerId, jobId);
    if (job.status !== 'delivered') {
      throw new Error(`job is ${job.status}, not awaiting acceptance`);
    }
    this.releaseDeliveredJob(job, null);
    this.log(`job ${jobId} accepted by buyer`);
    return this.db.getJob(jobId)!;
  }

  /** Buyer disputes a delivered job — payment is held for arbitration. */
  disputeJob(buyerId: string, jobId: string): Job {
    if (this.acceptanceWindowMs === 0) {
      throw new Error('disputes are disabled (no acceptance window configured)');
    }
    const job = this.requireBuyerJob(buyerId, jobId);
    if (job.status !== 'delivered') {
      throw new Error(`job is ${job.status}, not awaiting acceptance`);
    }
    this.db.updateJob(jobId, { status: 'disputed' });
    this.log(`job ${jobId} disputed by buyer`);
    return this.db.getJob(jobId)!;
  }

  /** Arbitrate a disputed job (admin only). */
  resolveJob(jobId: string, ruling: Resolution): Job {
    const job = this.db.getJob(jobId);
    if (!job) throw new Error('job not found');
    if (job.status !== 'disputed') {
      throw new Error(`job is ${job.status}, not disputed`);
    }
    if (ruling === 'worker') {
      this.releaseDeliveredJob(job, 'worker');
    } else {
      this.refundDeliveredJob(job);
    }
    this.log(`job ${jobId} resolved in favour of the ${ruling}`);
    return this.db.getJob(jobId)!;
  }

  private requireBuyerJob(buyerId: string, jobId: string): Job {
    const job = this.db.getJob(jobId);
    if (!job || job.buyerId !== buyerId) throw new Error('job not found');
    return job;
  }

  // --- Workers / stats / federation ---------------------------------------

  listPublicWorkers(): PublicWorker[] {
    return this.db.listWorkers().map((w) => {
      const liveWorker = this.live.get(w.id);
      return {
        id: w.id,
        name: w.name,
        adapters: w.adapters,
        status: liveWorker ? (liveWorker.jobs.size > 0 ? 'busy' : 'idle') : 'offline',
        jobsCompleted: w.jobsCompleted,
        jobsFailed: w.jobsFailed,
        reputation: reputationScore({
          jobsCompleted: w.jobsCompleted,
          jobsFailed: w.jobsFailed,
          flaggedReports: w.flaggedReports,
        }),
        priceMultiplier: w.priceMultiplier,
        capacity: w.capacity,
        activeJobs: liveWorker ? liveWorker.jobs.size : 0,
        lastSeen: w.lastSeen,
      };
    });
  }

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
        this.db.countJobsByStatus('assigned') + this.db.countJobsByStatus('running'),
      jobsCompleted: this.db.countJobsByStatus('completed'),
      creditsInCirculation: this.ledger.creditsInCirculation(),
      totalTokensMetered: this.db.totalTokensMetered(),
    };
  }

  /**
   * Aggregate this coordinator with its peers into one federated view. Each
   * coordinator keeps its own ledger; this is a read-only roll-up.
   */
  async getFederation(): Promise<{
    coordinators: { url: string; online: boolean; stats: NetworkStats | null }[];
    aggregate: NetworkStats;
  }> {
    const local: NetworkStats = this.getStats();
    const coordinators: { url: string; online: boolean; stats: NetworkStats | null }[] = [
      { url: this.url, online: true, stats: local },
    ];

    for (const peer of this.peers) {
      try {
        const res = await fetch(`${peer.replace(/\/+$/, '')}/v1/stats`, {
          signal: AbortSignal.timeout(3_000),
        });
        coordinators.push({
          url: peer,
          online: res.ok,
          stats: res.ok ? ((await res.json()) as NetworkStats) : null,
        });
      } catch {
        coordinators.push({ url: peer, online: false, stats: null });
      }
    }

    const aggregate: NetworkStats = {
      users: 0,
      workers: 0,
      workersOnline: 0,
      jobsQueued: 0,
      jobsRunning: 0,
      jobsCompleted: 0,
      creditsInCirculation: 0,
      totalTokensMetered: 0,
    };
    for (const c of coordinators) {
      if (!c.stats) continue;
      aggregate.users += c.stats.users;
      aggregate.workers += c.stats.workers;
      aggregate.workersOnline += c.stats.workersOnline;
      aggregate.jobsQueued += c.stats.jobsQueued;
      aggregate.jobsRunning += c.stats.jobsRunning;
      aggregate.jobsCompleted += c.stats.jobsCompleted;
      aggregate.creditsInCirculation += c.stats.creditsInCirculation;
      aggregate.totalTokensMetered += c.stats.totalTokensMetered;
    }
    return { coordinators, aggregate };
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
        const capacity = msg.capacity ?? 1;
        const worker = this.db.upsertWorker(
          user.id,
          msg.name,
          msg.adapters,
          priceMultiplier,
          capacity,
        );
        workerId = worker.id;
        this.live.set(worker.id, {
          workerId: worker.id,
          userId: user.id,
          ws,
          adapters: msg.adapters,
          priceMultiplier,
          capacity,
          jobs: new Set(),
        });
        this.db.setWorkerStatus(worker.id, 'idle');
        send(ws, { type: 'registered', workerId: worker.id });
        this.log(
          `worker ${worker.name} online (${worker.id}) @ ${priceMultiplier}x, capacity ${capacity}`,
        );
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
          this.db.setWorkerStatus(lw.workerId, lw.jobs.size > 0 ? 'busy' : 'idle');
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
          this.onJobResult(lw, msg.jobId, msg.resultText, msg.outputFiles, msg.tokenUsage, msg.attestation);
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

    // Every job this worker held goes back into the queue for someone else.
    for (const jobId of lw.jobs) {
      const wasRunning = this.running.has(jobId);
      this.offers.delete(jobId);
      this.running.delete(jobId);
      if (wasRunning) this.db.recordWorkerFailure(workerId);
      const job = this.db.getJob(jobId);
      if (
        job &&
        (job.status === 'queued' || job.status === 'assigned' || job.status === 'running')
      ) {
        this.db.updateJob(jobId, { status: 'queued', workerId: null });
        this.log(`job ${jobId} re-queued (worker left)`);
      }
    }
    this.dispatch();
  }

  // --- Job lifecycle handlers ---------------------------------------------

  private onJobAccept(lw: LiveWorker, jobId: string): void {
    const offer = this.offers.get(jobId);
    if (!offer || offer.workerId !== lw.workerId || !lw.jobs.has(jobId)) return;
    this.offers.delete(jobId);
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
    this.freeWorkerJob(lw, jobId);
    this.dispatch();
  }

  private onJobProgress(lw: LiveWorker, jobId: string): void {
    if (!lw.jobs.has(jobId)) return;
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
    attestation: Attestation,
  ): void {
    if (!lw.jobs.has(jobId)) return; // stale result for a re-queued job
    const job = this.db.getJob(jobId);
    if (!job) return;

    this.running.delete(jobId);
    this.declined.delete(`${jobId}|${lw.workerId}`);
    this.freeWorkerJob(lw, jobId);

    // 1. Structural result check. An unusable result fails the job outright.
    const resultCheck = checkResult(resultText, outputFiles);
    if (!isResultUsable(resultText, outputFiles)) {
      this.ledger.refundJob(jobId, job.buyerId, job.maxCredits);
      this.db.recordWorkerFailure(lw.workerId);
      this.db.updateJob(jobId, {
        status: 'failed',
        workerId: lw.workerId,
        resultText,
        outputFiles,
        tokenUsage,
        attestation,
        resultCheck,
        error: 'result check failed: ' + resultCheck.reasons.join('; '),
      });
      this.log(`job ${jobId} rejected — unusable result`);
      this.dispatch();
      return;
    }

    // 2. Verify the token-usage report and price the job.
    const verification = verifyUsage(tokenUsage, job.adapter, {
      inputChars: job.prompt.length + sumChars(job.inputFiles),
      outputChars: resultText.length + sumChars(outputFiles),
    });
    const measuredCredits = usdToCredits(verification.verifiedCostUsd);
    const pricedCredits = Math.max(0, Math.ceil(measuredCredits * lw.priceMultiplier));
    const settlement = computeSettlement(pricedCredits, job.maxCredits, this.platformFee);

    // 3. Settle immediately, or deliver into the acceptance window.
    if (this.acceptanceWindowMs === 0) {
      this.applySettlement(job, lw.workerId, settlement, verification.ok);
      this.db.updateJob(jobId, {
        status: 'completed',
        workerId: lw.workerId,
        resultText,
        outputFiles,
        tokenUsage,
        verification,
        attestation,
        resultCheck,
        settlement,
        costCredits: settlement.charged,
      });
      this.log(
        `job ${jobId} completed — charged ${settlement.charged}, worker earned ${settlement.workerEarned}`,
      );
    } else {
      this.db.updateJob(jobId, {
        status: 'delivered',
        workerId: lw.workerId,
        resultText,
        outputFiles,
        tokenUsage,
        verification,
        attestation,
        resultCheck,
        settlement,
        deliveredAt: Date.now(),
      });
      this.log(`job ${jobId} delivered — awaiting buyer acceptance`);
    }
    this.dispatch();
  }

  private onJobFailed(lw: LiveWorker, jobId: string, error: string): void {
    if (!lw.jobs.has(jobId)) return;
    const job = this.db.getJob(jobId);
    this.running.delete(jobId);
    this.freeWorkerJob(lw, jobId);
    if (job && job.status !== 'completed' && job.status !== 'failed') {
      this.ledger.refundJob(jobId, job.buyerId, job.maxCredits);
      this.db.updateJob(jobId, { status: 'failed', error });
      this.db.recordWorkerFailure(lw.workerId);
      this.log(`job ${jobId} failed: ${error}`);
    }
    this.dispatch();
  }

  // --- Settlement of delivered jobs ---------------------------------------

  /** Move credits for a settled job and update the worker's lifetime stats. */
  private applySettlement(
    job: Job,
    workerId: string,
    settlement: Settlement,
    verificationOk: boolean,
  ): void {
    const workerInfo = this.db.getWorker(workerId);
    if (!workerInfo) return;
    this.ledger.settleJob(
      job.id,
      job.buyerId,
      workerInfo.userId,
      job.maxCredits,
      settlement,
    );
    this.db.recordWorkerCompletion(workerId, settlement.workerEarned);
    if (!verificationOk) {
      this.db.recordWorkerFlag(workerId);
      this.log(`job ${job.id} usage was flagged`);
    }
  }

  /** Pay out a delivered job (buyer accepted, window expired, or arbitrated). */
  private releaseDeliveredJob(job: Job, resolution: Resolution | null): void {
    if (!job.settlement || !job.workerId) return;
    this.applySettlement(job, job.workerId, job.settlement, job.verification?.ok ?? true);
    this.db.updateJob(job.id, {
      status: 'completed',
      costCredits: job.settlement.charged,
      resolution,
    });
  }

  /** Refund a disputed job's full escrow to the buyer; the worker is not paid. */
  private refundDeliveredJob(job: Job): void {
    this.ledger.refundJob(job.id, job.buyerId, job.maxCredits);
    if (job.workerId) this.db.recordWorkerFailure(job.workerId);
    this.db.updateJob(job.id, {
      status: 'completed',
      costCredits: 0,
      resolution: 'buyer',
    });
  }

  private freeWorkerJob(lw: LiveWorker, jobId: string): void {
    lw.jobs.delete(jobId);
    if (this.live.has(lw.workerId)) {
      this.db.setWorkerStatus(lw.workerId, lw.jobs.size > 0 ? 'busy' : 'idle');
    }
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
   * Pick the best worker for a job: idle capacity, offers the adapter, has not
   * declined the job, priced within the buyer's limit. Cheapest wins, with
   * reputation as the tiebreaker.
   */
  private findWorkerFor(job: Job): LiveWorker | null {
    const eligible: { lw: LiveWorker; reputation: number }[] = [];
    for (const lw of this.live.values()) {
      if (lw.jobs.size >= lw.capacity) continue;
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
        a.lw.priceMultiplier - b.lw.priceMultiplier || b.reputation - a.reputation,
    );
    return eligible[0]!.lw;
  }

  private offerJob(job: Job, worker: LiveWorker): void {
    worker.jobs.add(job.id);
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

  /** Periodic sweep: expire offers, re-queue stuck jobs, release held jobs. */
  private sweep(): void {
    const now = Date.now();

    for (const [jobId, offer] of this.offers) {
      if (offer.expiresAt > now) continue;
      this.offers.delete(jobId);
      this.declined.add(`${jobId}|${offer.workerId}`);
      const lw = this.live.get(offer.workerId);
      if (lw) this.freeWorkerJob(lw, jobId);
      this.log(`offer for job ${jobId} expired`);
    }

    for (const [jobId, run] of this.running) {
      if (run.expiresAt > now) continue;
      this.running.delete(jobId);
      this.declined.add(`${jobId}|${run.workerId}`);
      const lw = this.live.get(run.workerId);
      if (lw) this.freeWorkerJob(lw, jobId);
      const job = this.db.getJob(jobId);
      if (job && (job.status === 'assigned' || job.status === 'running')) {
        this.db.updateJob(jobId, { status: 'queued', workerId: null });
        this.db.recordWorkerFailure(run.workerId);
        this.log(`job ${jobId} timed out — re-queued`);
      }
    }

    // Auto-release delivered jobs whose acceptance window has elapsed.
    if (this.acceptanceWindowMs > 0) {
      for (const job of this.db.listJobsByStatus('delivered')) {
        if (job.deliveredAt && job.deliveredAt + this.acceptanceWindowMs <= now) {
          this.releaseDeliveredJob(job, null);
          this.log(`job ${job.id} auto-accepted (window elapsed)`);
        }
      }
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
