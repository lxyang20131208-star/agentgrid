# AgentGrid

**A peer-to-peer grid for renting and sharing AI agent compute.**

Some people have spare capacity on their coding agents — a Claude Code or
Codex plan they don't fully use. Other people have more work than capacity.
AgentGrid connects the two: lend your idle agent and **earn credits**; spend
credits to have **someone else's agent run your tasks**.

Think of it as an energy grid for agent compute. Credits flow one way, work
flows the other, and the books always balance.

```
   buyer                coordinator                worker
   ─────                ───────────                ──────
   submit job  ───────▶  escrow credits
                         match to a worker  ──────▶  run the agent locally
                                                     (Claude Code / Codex)
                         settle ◀──────────────────  report result + tokens
   result    ◀───────── pay worker, refund rest
```

> ⚠️ **Read this first.** AgentGrid is a *task-routing and credit-accounting*
> layer. Each worker runs its **own** locally-installed agent under its **own**
> credentials — API keys never leave the worker's machine and are never
> transmitted. Even so, pooling or sharing access to subscription-based coding
> agents may conflict with the terms of service of the underlying providers
> (Anthropic, OpenAI, and others). AgentGrid is intended for sharing compute
> within a **trusted group** — a team, a co-op, a set of friends — where every
> participant consents. You are responsible for ensuring your use complies with
> the terms of any provider you connect. See
> [`docs/TRUST-AND-SECURITY.md`](docs/TRUST-AND-SECURITY.md).

---

## How it works

AgentGrid has three roles, all in one `agentgrid` binary:

| Role            | What it does                                                        |
| --------------- | ------------------------------------------------------------------- |
| **Coordinator** | The broker. Holds the job queue, the credit ledger, matches workers. |
| **Worker**      | Lends compute. Runs jobs on a locally-installed agent, earns credits. |
| **Client**      | Buys compute. Submits jobs, spends credits, gets results back.        |

**Credits** are the unit of account. They are pegged to a fixed fraction of a
US dollar (`$1 = 10,000 credits`) so "earn" and "spend" are symmetric and
comparable across providers. New accounts get a signup grant to bootstrap.

**Token metering** is per-provider. Claude Code reports its own dollar cost, so
metering is exact. Codex usage is parsed from its event stream (and estimated
from a rate table when unavailable). A buyer is charged the measured cost,
capped at the budget they escrowed; the worker earns that amount; any unspent
budget is refunded.

**The ledger** is double-entry: every credit movement is a balanced
transaction, so credits can never be silently created or lost. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Marketplace mechanics

AgentGrid is a real two-sided market, not just a job queue.

- **Pricing & bidding.** Each worker advertises a *price multiplier* — buyers
  pay `measuredCost × multiplier`. A worker can undercut the field
  (`--price 0.8`) to win more jobs or charge a premium for reputation. When
  several workers can do a job, **the cheapest one wins**; reputation breaks
  ties. Buyers can cap what they will pay with `--max-price`.

- **Token-usage verification.** Workers self-report token usage, but the
  coordinator does not take it on faith. It independently bounds every report:
  worker-estimated costs are clamped to a rate-table plausibility range, and
  absurd figures are clamped by a hard per-token ceiling. The buyer is billed
  the **verified** cost, and an implausible report is flagged against the
  worker. Provider-attested costs (Claude Code reports its own dollar figure)
  are trusted within the ceiling.

- **Reputation.** Every worker carries a 0-100 score derived from its record:
  jobs completed, jobs failed, and flagged usage reports. A flagged report
  hurts more than an honest failure. New workers start neutral (Bayesian
  prior). Reputation is the tiebreaker when prices are equal.

- **Sandboxing.** A worker runs untrusted prompts, so it can isolate them:
  `none` (trusted groups), `restricted` (environment scrubbed to an allowlist),
  or `container` (a locked-down `docker` container with the workspace
  bind-mounted, resource limits and dropped capabilities). See
  [`docs/TRUST-AND-SECURITY.md`](docs/TRUST-AND-SECURITY.md) and
  [`docker/Dockerfile`](docker/Dockerfile).

---

## Quickstart

Requires **Node.js 20+**. The `mock` adapter lets you run the entire network
with **no API keys and no token spend** — start there.

```bash
git clone https://github.com/lxyang20131208-star/agentgrid.git
cd agentgrid
npm install
npm run build
npm link            # puts `agentgrid` on your PATH (optional)
```

Open four terminals (or background the long-running ones):

```bash
# 1 — start the coordinator (the broker)
agentgrid coordinator

# 2 — register an account; this saves your API key to ~/.agentgrid/config.json
agentgrid register --email you@example.com

# 3 — lend compute: run a worker (auto-detects installed agents)
agentgrid worker --name my-worker

# 4 — buy compute: submit a job and wait for the result
agentgrid submit "Refactor utils.js into smaller modules" \
  --adapter mock --file ./utils.js --budget 5000 --wait
```

Check the economy:

```bash
agentgrid balance     # your credits
agentgrid workers     # who is online
agentgrid stats       # network-wide totals
agentgrid jobs        # your job history
```

When you have Claude Code or Codex installed, swap `--adapter mock` for
`--adapter claude-code` or `--adapter codex`. Run `agentgrid adapters` to see
what is detected on your machine.

---

## CLI reference

| Command                       | Description                                            |
| ----------------------------- | ------------------------------------------------------ |
| `agentgrid coordinator`       | Run the broker for a network.                          |
| `agentgrid register --email`  | Create an account and save its API key.                |
| `agentgrid worker`            | Run a worker. `--price` to set your rate, `--sandbox` to isolate jobs. |
| `agentgrid submit <prompt>`   | Submit a job (spends credits). `--wait` to block, `--max-price` to cap. |
| `agentgrid status <jobId>`    | Show a job's status and result.                        |
| `agentgrid jobs`              | List your recent jobs.                                 |
| `agentgrid balance`           | Show your credit balance.                              |
| `agentgrid workers`           | List workers on the network.                           |
| `agentgrid stats`             | Show network-wide statistics.                          |
| `agentgrid adapters`          | Show which agent adapters are installed locally.       |

Configuration lives in `~/.agentgrid/config.json` and can be overridden with
`AGENTGRID_URL` and `AGENTGRID_API_KEY`. See [`.env.example`](.env.example).

---

## Adapters

An *adapter* teaches a worker how to drive one agent backend.

| Adapter       | Backend                | Metering                              |
| ------------- | ---------------------- | ------------------------------------- |
| `mock`        | none — deterministic   | synthesised; always available         |
| `claude-code` | Anthropic Claude Code  | **exact** (`total_cost_usd` reported)  |
| `codex`       | OpenAI Codex CLI       | parsed from events, estimated fallback |

Adapters are small and pluggable — see
[`src/worker/adapters/`](src/worker/adapters/). Contributions for more
backends are welcome.

---

## Project layout

```
src/
  shared/        types, wire protocol, pricing, config
  coordinator/   broker: HTTP + WebSocket server, SQLite, double-entry ledger
  worker/        worker daemon, job runner, agent adapters
  client/        REST client for the coordinator API
  cli.ts         the unified `agentgrid` command
test/            ledger, pricing, and end-to-end tests (mock adapter)
docs/            architecture, protocol, trust & security
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, data model, job lifecycle.
- [Protocol](docs/PROTOCOL.md) — REST endpoints and the worker WebSocket protocol.
- [Trust & Security](docs/TRUST-AND-SECURITY.md) — the threat model, honestly.

## Roadmap

**Shipped in 0.2:** token-usage verification, worker sandboxing
(`none` / `restricted` / `container`), worker self-pricing with cheapest-wins
bidding, and a reputation system.

Still ahead:

- **Provider-side usage attestation** — verify token counts against the
  provider's own dashboard/API, not just plausibility bounds.
- **Streaming results** and richer multi-file / multi-directory workspaces.
- **Disputes & arbitration** — let a buyer contest a result after settlement.
- **Worker capacity > 1** — run several jobs per worker concurrently.
- **Federation** — multiple coordinators sharing a worker pool.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

## License

[MIT](LICENSE) — do what you like, no warranty.
