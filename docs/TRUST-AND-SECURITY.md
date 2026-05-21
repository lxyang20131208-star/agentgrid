# Trust & Security

This document is deliberately honest about what AgentGrid does and does **not**
protect against. AgentGrid is an MVP. Read this before running a worker for, or
submitting jobs to, people you do not trust.

## The short version

AgentGrid is safe to run **within a trusted group** — a team, a co-op, a set of
friends — where everyone consents. It is **not** yet hardened for an open,
adversarial, anonymous marketplace. Several important protections are listed
under "Known gaps" below as future work.

## Provider terms of service

AgentGrid routes tasks and accounts for credits. It does **not** proxy or pool
API keys: each worker runs its own locally-installed agent (Claude Code, Codex,
etc.) under its own credentials, and those credentials never leave the worker's
machine.

Even so, having your agent perform work *on behalf of someone else* may
conflict with the terms of service of the underlying provider. Subscription
coding agents are typically licensed to the account holder. **You are
responsible** for ensuring your use complies with the terms of every provider
you connect. The maintainers provide this software as-is, for research and
self-hosting, and take no position on your contractual obligations.

## Threat model

### 1. A malicious buyer attacks a worker's machine

A job prompt runs inside a real coding agent on the worker's computer. A hostile
prompt could try to read files, exfiltrate data, or run destructive commands.

**What AgentGrid does:** each job runs in a fresh temp directory that is deleted
afterwards, and only the buyer's declared input files are placed there. The
worker chooses a **sandbox mode** for the agent process itself:

- `none` — the agent runs directly with the full environment. For trusted
  groups only.
- `restricted` — the agent runs with its environment scrubbed to an allowlist,
  so a hostile prompt cannot read cloud credentials, SSH keys or unrelated API
  tokens out of `process.env`. It does **not** isolate the filesystem.
- `container` — the agent runs inside a `docker` container with only the job
  workspace bind-mounted, memory/CPU/PID limits, all capabilities dropped and
  `no-new-privileges` set. This is the only mode that isolates the filesystem
  and network.

The permission mode passed to coding agents is also configurable.

**What it does NOT do:** `none` and `restricted` do not stop a tool-using agent
from touching the wider filesystem. Only `container` does — and it is only as
strong as your Docker setup.

**Mitigation — strongly recommended:** for any untrusted buyer, run the worker
with `--sandbox container`. Even then, run the worker as an unprivileged user
on a machine that holds no secrets, and use the most restrictive permission
mode that still completes jobs.

### 2. A malicious worker mishandles a buyer's data

A job ships the buyer's prompt and input files to a worker. A hostile worker
could keep or leak them.

**What AgentGrid does:** input files live only in a temp workspace that the
runner deletes after the job.

**What it does NOT do:** it cannot prevent a worker from copying data it has
been given. Do not submit secrets, credentials, or proprietary code to workers
you do not trust.

### 3. A worker over-reports token usage

Workers self-report token counts and cost. A dishonest worker could inflate the
numbers to earn more credits.

**What AgentGrid does:** two layers of defence.

1. The buyer escrows a fixed `maxCredits` budget, and the charge is **capped at
   that budget** — a worker can never charge more than the buyer agreed to risk.
2. The coordinator **verifies every usage report** (`src/shared/verification.ts`).
   Worker-estimated costs are clamped to a rate-table plausibility bound; any
   cost is clamped by a hard per-token ceiling. The buyer is billed the
   *verified* cost, and an implausible report is flagged against the worker's
   reputation. Claude Code's cost is provider-attested, so it is trusted within
   the absolute ceiling.

**What it does NOT do:** verification bounds the *plausibility* of a report; it
does not cryptographically attest the exact token count with the provider.

**Mitigation:** set conservative `maxCredits` budgets and prefer the
`claude-code` adapter, whose cost is provider-reported. Provider-side usage
attestation is on the roadmap.

### 4. Credit integrity

The ledger is double-entry. Every transaction's legs sum to zero, and the sum of
every entry in the database is always zero. Credits cannot be created or
destroyed except by the `system` mint account (signup grants). The test suite
asserts this invariant. A bug that unbalanced the books would throw rather than
corrupt balances.

### 5. Authentication

Accounts authenticate with a bearer API key. The coordinator stores only a
SHA-256 hash of the key. There is no password, no session, no key rotation yet.
Treat the API key like a password. Run the coordinator behind TLS in any
non-local deployment (e.g. a reverse proxy) so keys are not sent in clear text.

## Known gaps (roadmap)

Addressed in 0.2: agent-process sandboxing (`container` mode), token-usage
verification, and worker reputation. Still open:

- **No provider-side usage attestation.** Verification bounds plausibility but
  does not confirm exact token counts with the provider.
- **No job-result verification.** The coordinator does not check that a result
  actually satisfies the prompt.
- **No dispute or refund-after-completion mechanism.**
- **No rate limiting** on the REST API.
- **No key rotation or revocation.**
- **TLS is not built in** — terminate it with a reverse proxy.

## Reporting a vulnerability

Open a GitHub issue for non-sensitive bugs. For anything security-sensitive,
please disclose privately to the repository maintainers first.
