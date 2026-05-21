# Contributing to AgentGrid

Thanks for your interest. AgentGrid is an MVP and there is plenty to do.

## Development setup

Requires Node.js 20+.

```bash
git clone https://github.com/lxyang20131208-star/agentgrid.git
cd agentgrid
npm install
npm run build      # compile TypeScript to dist/
npm test           # run the test suite (uses the mock adapter — no API keys)
npm run typecheck  # type-check without emitting
```

Run a command in development without building:

```bash
npm run dev -- coordinator
npm run dev -- submit "hello" --adapter mock
```

## Project layout

```
src/shared/        types, wire protocol, pricing, config — no I/O
src/coordinator/   broker: server, db, ledger, matcher
src/worker/        worker daemon, runner, adapters
src/client/        REST client
src/cli.ts         the unified CLI
test/              node:test suites
docs/              architecture, protocol, trust & security
```

## Guidelines

- **TypeScript, strict mode.** `npm run typecheck` must pass.
- **Keep the dependency list short.** AgentGrid deliberately has very few
  dependencies. Adding one needs a good reason.
- **Tests for behaviour changes.** The `mock` adapter exists so the whole
  network can be tested with no API keys — use it. Ledger and pricing logic
  should have unit tests.
- **The ledger invariant is sacred.** Any change to credit movement must keep
  every transaction balanced (legs sum to zero). The tests assert this.
- **Match the existing style.** Small modules, clear names, comments that
  explain *why* rather than *what*.

## Good first contributions

- A new agent adapter (Gemini CLI, Aider, Cursor CLI, …). Implement the
  `AgentAdapter` interface in `src/worker/adapters/` — `mock.ts` is the
  simplest example to copy.
- Improved token-usage parsing for the Codex adapter.
- A `--json` output mode for CLI commands.
- Rate limiting on the REST API.

## Pull requests

1. Fork and branch from `main`.
2. Make the change with tests.
3. Ensure `npm run build`, `npm run typecheck` and `npm test` all pass.
4. Open a PR describing the change and the reasoning.

By contributing you agree your work is licensed under the project's
[MIT License](LICENSE).
