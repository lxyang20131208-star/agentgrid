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
| `agentgrid worker`            | Run a worker that earns credits by executing jobs.     |
| `agentgrid submit <prompt>`   | Submit a job (spends credits). `--wait` to block.      |
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

AgentGrid is an MVP. Known limitations and planned work:

- **Token-report verification.** Workers currently self-report usage; a buyer's
  exposure is bounded by their escrow, but cross-checks are future work.
- **Worker sandboxing.** Running untrusted prompts should happen in a container;
  today this is the worker operator's responsibility.
- **Marketplace pricing.** Workers should be able to set their own rates and
  compete; v1 charges measured cost flat.
- **Reputation.** Worker ratings, job verification, dispute handling.
- **Streaming results** and richer multi-file workspaces.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

## License

[MIT](LICENSE) — do what you like, no warranty.
