# Protocol

AgentGrid has two interfaces: an HTTP REST API for clients, and a WebSocket
protocol for workers. Both run on the same coordinator port.

## REST API (clients)

Base path: `/v1`. All bodies are JSON. Authenticated endpoints require an
`Authorization: Bearer <apiKey>` header.

### `GET /v1/health`

Public. Returns `{ "ok": true, "version": "0.1.0" }`.

### `GET /v1/stats`

Public. Network-wide counters.

```json
{
  "users": 12, "workers": 4, "workersOnline": 3,
  "jobsQueued": 1, "jobsRunning": 2, "jobsCompleted": 87,
  "creditsInCirculation": 1200000, "totalTokensMetered": 4500000
}
```

### `GET /v1/workers`

Public. Lists workers and their status (`idle` / `busy` / `offline`).

### `POST /v1/register`

Public. Body `{ "email": "you@example.com" }`. Creates an account, grants
signup credits, and returns `{ userId, email, apiKey }`. **The API key is shown
once** — store it.

### `GET /v1/account`

Auth. Returns the caller's balance and escrowed credits.

### `POST /v1/jobs`

Auth. Submit a job.

```json
{
  "adapter": "claude-code",
  "prompt": "Add input validation to the login handler.",
  "inputFiles": [{ "path": "login.ts", "content": "..." }],
  "maxCredits": 5000
}
```

The coordinator escrows `maxCredits` immediately. Responds `201` with the job,
`402` if the buyer cannot afford it, `400` on a bad spec.

### `GET /v1/jobs`

Auth. Lists the caller's recent jobs.

### `GET /v1/jobs/:id`

Auth. Returns one job (must belong to the caller). Poll this for the result.

## WebSocket protocol (workers)

Workers connect to `ws://<coordinator>/v1/worker?key=<apiKey>`. The connection
stays open. Every message is a JSON object with a `type` field. Schemas are in
[`src/shared/protocol.ts`](../src/shared/protocol.ts) and validated with zod on
receipt.

### Worker → Coordinator

| Type           | Payload                                          | Meaning                          |
| -------------- | ------------------------------------------------ | -------------------------------- |
| `register`     | `name`, `adapters[]`                             | Announce presence and capability. |
| `heartbeat`    | —                                                | Keep-alive.                       |
| `job_accept`   | `jobId`                                          | Take an offered job.              |
| `job_decline`  | `jobId`, `reason?`                               | Refuse an offered job.            |
| `job_progress` | `jobId`, `message`                               | Human-readable progress.          |
| `job_result`   | `jobId`, `resultText`, `outputFiles[]`, `tokenUsage` | Job finished successfully.    |
| `job_failed`   | `jobId`, `error`                                 | Job failed; escrow is refunded.   |

### Coordinator → Worker

| Type            | Payload                  | Meaning                              |
| --------------- | ------------------------ | ------------------------------------ |
| `registered`    | `workerId`               | Registration accepted.               |
| `job_offer`     | `job` (id, adapter, prompt, inputFiles, maxCredits) | A job is offered. |
| `job_cancelled` | `jobId`                  | Stop working on this job.            |
| `ack`           | `jobId`                  | Generic acknowledgement.             |
| `error`         | `message`                | A protocol or auth error.            |

### Handshake and lifecycle

```
worker                          coordinator
  │   ── ws connect ?key=… ──▶   │  authenticate API key
  │   ── register ───────────▶   │  upsert worker row
  │   ◀────────── registered ─   │
  │                              │
  │   ◀────────── job_offer ──   │  (15s to respond)
  │   ── job_accept ─────────▶   │  job → assigned
  │   ── job_progress ───────▶   │  job → running
  │   ── job_result ─────────▶   │  settle ledger, job → completed
  │                              │
  │   ── heartbeat ──────────▶   │  (every 20s)
```

If the worker disconnects or a job exceeds its timeout, the coordinator
re-queues the job for another worker. The worker reconnects automatically.

## Token usage object

Reported by the worker on `job_result` and recorded against the job:

```json
{
  "inputTokens": 1234,
  "outputTokens": 567,
  "cacheCreationInputTokens": 0,
  "cacheReadInputTokens": 0,
  "totalTokens": 1801,
  "costUsd": 0.0123,
  "estimated": false
}
```

`estimated` is `false` when the provider reported a real dollar cost (Claude
Code) and `true` when AgentGrid derived it from a token-rate table.
