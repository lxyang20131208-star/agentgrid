// HTTP REST surface for the coordinator.
//
// Kept deliberately small: a handful of JSON endpoints over node:http with no
// web framework. The WebSocket surface for workers is wired up separately in
// index.ts on the same server.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ADAPTER, JOB_FILE } from '../shared/protocol.js';
import { InsufficientCreditsError } from './ledger.js';
import type { Coordinator } from './index.js';

const VERSION = '0.3.0';

const JOB_SUBMIT = z.object({
  adapter: ADAPTER,
  prompt: z.string().min(1).max(100_000),
  inputFiles: z.array(JOB_FILE).max(200).optional(),
  maxCredits: z.number().int().positive().max(100_000_000),
  /** Refuse workers priced above this multiplier. Omit for no limit. */
  maxPriceMultiplier: z.number().positive().max(100).optional(),
});

const REGISTER = z.object({
  email: z.string().email().max(254),
});

const RESOLVE = z.object({
  ruling: z.enum(['worker', 'buyer']),
});

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length).trim();
}

/** Build the node:http request handler bound to a coordinator instance. */
export function createHttpHandler(coord: Coordinator) {
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // --- Public endpoints --------------------------------------------------
      if (method === 'GET' && path === '/v1/health') {
        return sendJson(res, 200, { ok: true, version: VERSION });
      }

      if (method === 'GET' && path === '/v1/stats') {
        return sendJson(res, 200, coord.getStats());
      }

      if (method === 'GET' && path === '/v1/workers') {
        return sendJson(res, 200, { workers: coord.listPublicWorkers() });
      }

      if (method === 'GET' && path === '/v1/federation') {
        return sendJson(res, 200, await coord.getFederation());
      }

      // Arbitration — authenticated with the coordinator admin key, not a
      // user API key, so it is handled before the user-auth gate below.
      const resolveMatch = path.match(/^\/v1\/jobs\/([\w-]+)\/resolve$/);
      if (method === 'POST' && resolveMatch) {
        if (!coord.authenticateAdmin(bearerToken(req))) {
          return sendJson(res, 401, { error: 'admin key required' });
        }
        const parsed = RESOLVE.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          return sendJson(res, 400, { error: 'ruling must be "worker" or "buyer"' });
        }
        try {
          const job = coord.resolveJob(resolveMatch[1]!, parsed.data.ruling);
          return sendJson(res, 200, { job });
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'resolve failed',
          });
        }
      }

      if (method === 'POST' && path === '/v1/register') {
        const parsed = REGISTER.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          return sendJson(res, 400, { error: 'invalid email' });
        }
        try {
          const { user, apiKey } = coord.register(parsed.data.email);
          return sendJson(res, 201, {
            userId: user.id,
            email: user.email,
            apiKey,
          });
        } catch (err) {
          return sendJson(res, 409, {
            error: err instanceof Error ? err.message : 'registration failed',
          });
        }
      }

      // --- Authenticated endpoints ------------------------------------------
      const token = bearerToken(req);
      const user = token ? coord.authenticate(token) : null;
      if (path.startsWith('/v1/account') || path.startsWith('/v1/jobs')) {
        if (!user) {
          return sendJson(res, 401, { error: 'missing or invalid API key' });
        }
      }

      if (method === 'GET' && path === '/v1/account' && user) {
        return sendJson(res, 200, coord.getAccountInfo(user.id));
      }

      if (method === 'POST' && path === '/v1/jobs' && user) {
        const parsed = JOB_SUBMIT.safeParse(await readJsonBody(req));
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'invalid job spec',
            details: parsed.error.issues,
          });
        }
        try {
          const job = coord.submitJob(user.id, {
            adapter: parsed.data.adapter,
            prompt: parsed.data.prompt,
            inputFiles: parsed.data.inputFiles ?? [],
            maxCredits: parsed.data.maxCredits,
            maxPriceMultiplier: parsed.data.maxPriceMultiplier,
          });
          return sendJson(res, 201, { job });
        } catch (err) {
          if (err instanceof InsufficientCreditsError) {
            return sendJson(res, 402, {
              error: err.message,
              required: err.required,
              available: err.available,
            });
          }
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'job submission failed',
          });
        }
      }

      if (method === 'GET' && path === '/v1/jobs' && user) {
        return sendJson(res, 200, { jobs: coord.listJobs(user.id) });
      }

      const jobMatch = path.match(/^\/v1\/jobs\/([\w-]+)$/);
      if (method === 'GET' && jobMatch && user) {
        const job = coord.getJob(jobMatch[1]!);
        if (!job || job.buyerId !== user.id) {
          return sendJson(res, 404, { error: 'job not found' });
        }
        return sendJson(res, 200, { job });
      }

      const acceptMatch = path.match(/^\/v1\/jobs\/([\w-]+)\/accept$/);
      if (method === 'POST' && acceptMatch && user) {
        try {
          return sendJson(res, 200, { job: coord.acceptJob(user.id, acceptMatch[1]!) });
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'accept failed',
          });
        }
      }

      const disputeMatch = path.match(/^\/v1\/jobs\/([\w-]+)\/dispute$/);
      if (method === 'POST' && disputeMatch && user) {
        try {
          return sendJson(res, 200, { job: coord.disputeJob(user.id, disputeMatch[1]!) });
        } catch (err) {
          return sendJson(res, 400, {
            error: err instanceof Error ? err.message : 'dispute failed',
          });
        }
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      return sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'internal error',
      });
    }
  };
}
