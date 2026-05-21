// HTTP client for the coordinator REST API. Used by the CLI and embeddable in
// other programs that want to submit jobs to an AgentGrid network.

import type {
  AccountInfo,
  Job,
  JobSpec,
  NetworkStats,
  PublicWorker,
  Resolution,
} from '../shared/types.js';

export interface FederationView {
  coordinators: { url: string; online: boolean; stats: NetworkStats | null }[];
  aggregate: NetworkStats;
}

export interface RegisterResult {
  userId: string;
  email: string;
  apiKey: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class CoordinatorClient {
  constructor(
    private readonly baseUrl: string,
    private apiKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    authToken?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = authToken ?? this.apiKey;
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(
        0,
        `cannot reach coordinator at ${this.baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        null,
      );
    }

    const text = await res.text();
    const json = text ? safeParse(text) : null;
    if (!res.ok) {
      const message =
        (json && typeof json === 'object' && 'error' in json
          ? String((json as { error: unknown }).error)
          : `request failed (${res.status})`);
      throw new ApiError(res.status, message, json);
    }
    return json as T;
  }

  // --- Endpoints -----------------------------------------------------------

  health(): Promise<{ ok: boolean; version: string }> {
    return this.request('GET', '/v1/health');
  }

  register(email: string): Promise<RegisterResult> {
    return this.request('POST', '/v1/register', { email });
  }

  account(): Promise<AccountInfo> {
    return this.request('GET', '/v1/account');
  }

  submitJob(spec: JobSpec): Promise<{ job: Job }> {
    return this.request('POST', '/v1/jobs', spec);
  }

  getJob(id: string): Promise<{ job: Job }> {
    return this.request('GET', `/v1/jobs/${id}`);
  }

  listJobs(): Promise<{ jobs: Job[] }> {
    return this.request('GET', '/v1/jobs');
  }

  listWorkers(): Promise<{ workers: PublicWorker[] }> {
    return this.request('GET', '/v1/workers');
  }

  stats(): Promise<NetworkStats> {
    return this.request('GET', '/v1/stats');
  }

  federation(): Promise<FederationView> {
    return this.request('GET', '/v1/federation');
  }

  /** Accept a delivered job — pays the worker immediately. */
  acceptJob(id: string): Promise<{ job: Job }> {
    return this.request('POST', `/v1/jobs/${id}/accept`, {});
  }

  /** Dispute a delivered job — holds payment for arbitration. */
  disputeJob(id: string): Promise<{ job: Job }> {
    return this.request('POST', `/v1/jobs/${id}/dispute`, {});
  }

  /** Arbitrate a disputed job. Requires the coordinator admin key. */
  resolveJob(
    id: string,
    ruling: Resolution,
    adminKey: string,
  ): Promise<{ job: Job }> {
    return this.request('POST', `/v1/jobs/${id}/resolve`, { ruling }, adminKey);
  }

  /**
   * Poll a job until it reaches a terminal state or the timeout elapses.
   * 'delivered' counts as terminal — the result is available even though the
   * acceptance window has not closed.
   */
  async waitForJob(id: string, timeoutMs = 15 * 60_000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { job } = await this.getJob(id);
      if (
        job.status === 'completed' ||
        job.status === 'delivered' ||
        job.status === 'failed' ||
        job.status === 'cancelled'
      ) {
        return job;
      }
      await sleep(1_500);
    }
    throw new Error(`timed out waiting for job ${id}`);
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
