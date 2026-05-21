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
afterwards. Only the buyer's declared input files are placed there. The
permission mode passed to the agent is configurable.

**What it does NOT do:** it does not sandbox the agent process itself. A coding
agent with tool access can still touch the wider filesystem and network.

**Mitigation — strongly recommended:** run the worker inside a container or VM
with no access to anything you care about. Run it as an unprivileged user. Use
the most restrictive permission mode that still completes jobs. Do not run a
worker for untrusted buyers on a machine that holds secrets.

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

**What AgentGrid does:** the buyer escrows a fixed `maxCredits` budget. The
charge is **capped at that budget** — a worker can never charge more than the
buyer agreed to risk. Claude Code reports its own dollar cost, so for that
adapter the figure is provider-attested rather than worker-asserted.

**What it does NOT do:** within the budget cap, it does not independently verify
token counts.

**Mitigation:** set conservative `maxCredits` budgets. Prefer the `claude-code`
adapter, whose cost is provider-reported. Provider-side usage verification is on
the roadmap.

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

- **No agent-process sandboxing.** Containerisation is the operator's job today.
- **No token-report verification** beyond the escrow budget cap.
- **No worker reputation or job-result verification.**
- **No dispute or refund-after-completion mechanism.**
- **No rate limiting** on the REST API.
- **No key rotation or revocation.**
- **TLS is not built in** — terminate it with a reverse proxy.

## Reporting a vulnerability

Open a GitHub issue for non-sensitive bugs. For anything security-sensitive,
please disclose privately to the repository maintainers first.
