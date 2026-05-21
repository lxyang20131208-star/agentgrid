# Architecture

AgentGrid is three cooperating roles plus a credit ledger. This document
describes the components, the data model, and the lifecycle of a job.

## Components

```
                       ┌─────────────────────────────┐
                       │        COORDINATOR          │
   HTTP / REST         │  ┌───────────────────────┐  │
 ┌──────────┐  jobs    │  │ HTTP server (REST)    │  │
 │  CLIENT  │─────────▶│  │ WebSocket server      │  │
 └──────────┘  results │  │ matcher / dispatcher  │  │
       ▲               │  │ double-entry ledger   │  │
       │               │  │ SQLite (jobs+ledger)  │  │
       │               │  └───────────────────────┘  │
       │               └──────────────┬──────────────┘
       │                              │ WebSocket
       │                       ┌──────┴───────┐
       └───────────────────────│    WORKER    │
            (settled credits)  │  runner      │
                               │  adapters    │──▶ claude-code / codex / mock
                               └──────────────┘
```

### Coordinator

The broker. It is the only component that needs to be reachable by everyone.

- **HTTP server** (`src/coordinator/server.ts`) — a small JSON REST API over
  `node:http`, no web framework. Used by clients.
- **WebSocket server** (`src/coordinator/index.ts`) — workers connect to
  `/v1/worker` and stay connected. Jobs are pushed to them.
- **Matcher / dispatcher** — pairs queued jobs with idle workers that offer the
  requested adapter. Handles offers, acceptances, declines, timeouts and
  re-queueing.
- **Ledger** (`src/coordinator/ledger.ts`) — double-entry credit accounting.
- **Store** (`src/coordinator/db.ts`) — a SQLite database holding users,
  workers, jobs and the ledger tables.

### Worker

A daemon that lends a machine's agent compute.

- Connects out to a coordinator over WebSocket — no inbound ports needed.
- Advertises which **adapters** it can run (auto-detected or configured).
- Accepts one job at a time, runs it via the **runner**, reports the result.
- The **runner** (`src/worker/runner.ts`) creates a throwaway temp workspace,
  writes the buyer's input files, invokes the adapter, and collects any files
  the agent created or changed. The workspace is deleted afterwards.
- **Adapters** (`src/worker/adapters/`) translate a job into a real agent
  invocation and measure token usage.

### Client

A thin REST client (`src/client/index.ts`) used by the CLI and embeddable in
other programs. It submits jobs, polls for results and reads account state.

## Data model

SQLite, six tables:

| Table          | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| `users`        | Accounts. Holds the hashed API key.                           |
| `workers`      | Registered workers and their lifetime stats.                  |
| `jobs`         | Every job, its spec, status and result.                       |
| `accounts`     | Ledger accounts: one `system`, one `escrow`, one per user.    |
| `transactions` | One row per credit movement.                                  |
| `entries`      | The legs of each transaction. Amounts per transaction sum 0.  |

## The credit ledger

Credits are tracked with **double-entry bookkeeping**. Every movement is a
*transaction* made of two or more *entries* whose amounts sum to zero.

- An account's balance is the sum of its entries.
- The `system` account is the mint: it goes negative when it grants credits.
- The `escrow` account holds budgets for in-flight jobs.
- The sum of **every entry in the database is always zero** — a self-check that
  guarantees credits are never created or destroyed except by the mint.

Four transaction kinds:

| Kind           | Legs                                                            |
| -------------- | --------------------------------------------------------------- |
| `signup_grant` | `system → user`                                                 |
| `job_escrow`   | `buyer → escrow`                                                |
| `job_settle`   | `escrow → worker`, `escrow → system` (fee), `escrow → buyer` (refund) |
| `job_refund`   | `escrow → buyer`                                                |

## Matching, pricing and verification

- **Matching.** When a job is queued, the coordinator collects every idle
  worker that offers the job's adapter, has not declined it, and prices itself
  within the buyer's `maxPriceMultiplier`. It picks the **cheapest**; reputation
  breaks ties. This is the network's price-competition mechanism.
- **Pricing.** Each worker advertises a `priceMultiplier`. The buyer is billed
  `verifiedCost × multiplier`, still capped at the escrowed budget.
- **Verification** (`src/shared/verification.ts`). Before settling, the
  coordinator bounds the worker's token-usage report: worker-estimated costs
  are clamped to a rate-table plausibility range, and any cost is clamped by a
  hard per-token ceiling. The buyer is billed the verified figure; an
  implausible report is flagged against the worker.
- **Reputation** (`src/shared/reputation.ts`). A 0-100 Bayesian score from each
  worker's completed jobs, failed jobs and flagged reports. Used as the
  matching tiebreaker and surfaced to buyers.

## Job lifecycle

```
            submit                offer/accept            result
  (none) ─────────▶ queued ──────────────────▶ assigned ──────────▶ completed
                      │                           │  running          │
                      │ no worker / decline       │ failure           │ failure
                      │ ◀─────────────────────────┘ ─────────────────▶ failed
                      ▼
                  (waits in queue)
```

1. **submit** — the client `POST`s a job. The coordinator escrows
   `maxCredits` from the buyer and stores the job as `queued`.
2. **dispatch** — the matcher finds the cheapest eligible worker offering the
   job's adapter (reputation breaks ties) and sends a `job_offer`.
3. **accept** — the worker replies `job_accept`; the job becomes `assigned`.
   (A decline or a 15s timeout returns the job to the queue for another worker.)
4. **run** — the worker executes the job locally. It may emit `job_progress`,
   which moves the job to `running`.
5. **result** — the worker sends `job_result` with the output and measured
   token usage. The coordinator *verifies* that usage, applies the worker's
   price multiplier, settles the ledger, and marks the job `completed`. On
   `job_failed`, the escrow is fully refunded and the job is `failed`.
6. **timeout / disconnect** — if a worker vanishes mid-job, the job is
   re-queued so another worker can pick it up.

## Why these choices

- **SQLite, no native server.** Zero-config: a coordinator is one process and
  one file. Easy to self-host, easy to inspect, transactional enough for a
  ledger.
- **WebSocket for workers.** Workers sit behind NATs and firewalls; an outbound
  long-lived connection means they need no inbound ports.
- **One binary, three roles.** Lowers the barrier to running every part of the
  network yourself.
- **A `mock` adapter.** The whole system is testable and demoable with no API
  keys and no token spend.
