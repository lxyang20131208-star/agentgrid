#!/usr/bin/env node
// AgentGrid command-line interface.
//
// One binary, several subcommands:
//   coordinator  run the broker that matches jobs to workers
//   register     create an account and save its API key
//   worker       lend this machine's agent compute to the network
//   submit       pay credits to have the network run a task
//   status/jobs/balance/workers/stats  inspect the network

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Command } from 'commander';
import { loadConfig, saveConfig, configPath } from './shared/config.js';
import {
  DEFAULT_PLATFORM_FEE,
  DEFAULT_SIGNUP_GRANT,
  creditsToUsd,
} from './shared/pricing.js';
import type { AdapterName, JobFile } from './shared/types.js';
import { Coordinator } from './coordinator/index.js';
import { Worker, probeAdapters } from './worker/index.js';
import { CoordinatorClient, ApiError } from './client/index.js';

const program = new Command();
program
  .name('agentgrid')
  .description('A peer-to-peer grid for renting and sharing AI agent compute.')
  .version('0.2.0');

// --- coordinator -----------------------------------------------------------

program
  .command('coordinator')
  .description('Run the coordinator (the broker for the whole network).')
  .option('-p, --port <port>', 'port to listen on', process.env.AGENTGRID_PORT ?? '7420')
  .option('--db <path>', 'SQLite database file', process.env.AGENTGRID_DB ?? 'agentgrid.sqlite')
  .option('--signup-grant <credits>', 'credits granted to each new account')
  .option('--platform-fee <fraction>', 'fee fraction taken per settled job')
  .action(async (opts) => {
    const coordinator = new Coordinator({
      port: Number(opts.port),
      dbPath: opts.db,
      signupGrant: opts.signupGrant
        ? Number(opts.signupGrant)
        : Number(process.env.AGENTGRID_SIGNUP_GRANT ?? DEFAULT_SIGNUP_GRANT),
      platformFee: opts.platformFee
        ? Number(opts.platformFee)
        : Number(process.env.AGENTGRID_PLATFORM_FEE ?? DEFAULT_PLATFORM_FEE),
    });
    await coordinator.start();
    console.log(`AgentGrid coordinator running. Database: ${opts.db}`);
    console.log('Press Ctrl+C to stop.');
    process.on('SIGINT', () => {
      console.log('\nshutting down...');
      void coordinator.stop().then(() => process.exit(0));
    });
  });

// --- register --------------------------------------------------------------

program
  .command('register')
  .description('Create an account on a coordinator and save its API key.')
  .requiredOption('-e, --email <email>', 'your email address')
  .option('-u, --url <url>', 'coordinator URL')
  .action(async (opts) => {
    const config = loadConfig();
    const url = opts.url ?? config.coordinatorUrl;
    const client = new CoordinatorClient(url);
    try {
      const result = await client.register(opts.email);
      saveConfig({
        coordinatorUrl: url,
        apiKey: result.apiKey,
        userId: result.userId,
        email: result.email,
      });
      console.log(`Registered ${result.email}`);
      console.log(`  User ID: ${result.userId}`);
      console.log(`  API key: ${result.apiKey}`);
      console.log(`Saved to ${configPath()}`);
    } catch (err) {
      fail(err);
    }
  });

// --- worker ----------------------------------------------------------------

program
  .command('worker')
  .description('Run a worker that earns credits by executing others’ jobs.')
  .option('-n, --name <name>', 'worker display name', `worker-${process.pid}`)
  .option('-a, --adapters <list>', 'comma-separated adapters (default: auto-detect)')
  .option('-m, --permission-mode <mode>', 'permission mode for coding agents', 'acceptEdits')
  .option('--price <multiplier>', 'your price — buyers pay measuredCost × this', '1')
  .option('-s, --sandbox <mode>', 'sandbox: none, restricted, or container', 'none')
  .option('--container-image <image>', 'docker image for container sandbox', 'agentgrid-worker')
  .option('--container-memory <mem>', 'memory limit for container sandbox', '2g')
  .option('--container-cpus <cpus>', 'cpu limit for container sandbox', '2')
  .option('--container-network <net>', 'docker network for container sandbox', 'bridge')
  .option('-u, --url <url>', 'coordinator URL')
  .action(async (opts) => {
    const config = loadConfig();
    const url = opts.url ?? config.coordinatorUrl;
    if (!config.apiKey) fail(new Error('not registered — run `agentgrid register` first'));

    const adapters = opts.adapters
      ? (opts.adapters.split(',').map((s: string) => s.trim()) as AdapterName[])
      : undefined;

    const worker = new Worker({
      coordinatorUrl: url,
      apiKey: config.apiKey!,
      name: opts.name,
      adapters,
      permissionMode: opts.permissionMode,
      priceMultiplier: Number(opts.price),
      sandbox: {
        mode: opts.sandbox,
        containerImage: opts.containerImage,
        containerMemory: opts.containerMemory,
        containerCpus: opts.containerCpus,
        containerNetwork: opts.containerNetwork,
      },
    });
    await worker.start();
    console.log('Worker online. Press Ctrl+C to stop.');
    process.on('SIGINT', () => {
      console.log('\nshutting down...');
      void worker.stop().then(() => process.exit(0));
    });
  });

// --- submit ----------------------------------------------------------------

program
  .command('submit')
  .description('Submit a job to the network (spends credits).')
  .argument('[prompt]', 'the task prompt')
  .option('-a, --adapter <name>', 'adapter to run on (claude-code, codex, mock)', 'mock')
  .option('-f, --file <path>', 'attach an input file (repeatable)', collect, [])
  .option('-b, --budget <credits>', 'max credits to spend', '5000')
  .option('--max-price <multiplier>', 'refuse workers priced above this multiplier')
  .option('-w, --wait', 'wait for the job to finish and print the result')
  .option('-u, --url <url>', 'coordinator URL')
  .action(async (prompt: string | undefined, opts) => {
    const config = loadConfig();
    if (!config.apiKey) fail(new Error('not registered — run `agentgrid register` first'));
    const text = prompt ?? readStdin();
    if (!text.trim()) fail(new Error('no prompt provided'));

    const inputFiles: JobFile[] = (opts.file as string[]).map((path) => ({
      path: basename(path),
      content: readFileSync(path, 'utf8'),
    }));

    const client = new CoordinatorClient(opts.url ?? config.coordinatorUrl, config.apiKey);
    try {
      const { job } = await client.submitJob({
        adapter: opts.adapter,
        prompt: text,
        inputFiles,
        maxCredits: Number(opts.budget),
        maxPriceMultiplier: opts.maxPrice ? Number(opts.maxPrice) : undefined,
      });
      console.log(`Submitted job ${job.id} (budget ${job.maxCredits} credits)`);

      if (!opts.wait) {
        console.log(`Track it with: agentgrid status ${job.id}`);
        return;
      }
      console.log('Waiting for a worker to finish the job...');
      const done = await client.waitForJob(job.id);
      printJob(done);
    } catch (err) {
      fail(err);
    }
  });

// --- status ----------------------------------------------------------------

program
  .command('status')
  .description('Show the status and result of a job.')
  .argument('<jobId>', 'the job id')
  .action(async (jobId: string) => {
    const config = loadConfig();
    if (!config.apiKey) fail(new Error('not registered — run `agentgrid register` first'));
    const client = new CoordinatorClient(config.coordinatorUrl, config.apiKey);
    try {
      const { job } = await client.getJob(jobId);
      printJob(job);
    } catch (err) {
      fail(err);
    }
  });

// --- jobs ------------------------------------------------------------------

program
  .command('jobs')
  .description('List your recent jobs.')
  .action(async () => {
    const config = loadConfig();
    if (!config.apiKey) fail(new Error('not registered — run `agentgrid register` first'));
    const client = new CoordinatorClient(config.coordinatorUrl, config.apiKey);
    try {
      const { jobs } = await client.listJobs();
      if (jobs.length === 0) {
        console.log('No jobs yet.');
        return;
      }
      for (const job of jobs) {
        const cost = job.costCredits !== null ? `${job.costCredits} cr` : '—';
        console.log(
          `${job.id}  ${job.status.padEnd(10)}  ${job.adapter.padEnd(12)}  ${cost.padStart(8)}  ${job.prompt.slice(0, 48)}`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// --- balance ---------------------------------------------------------------

program
  .command('balance')
  .description('Show your credit balance.')
  .action(async () => {
    const config = loadConfig();
    if (!config.apiKey) fail(new Error('not registered — run `agentgrid register` first'));
    const client = new CoordinatorClient(config.coordinatorUrl, config.apiKey);
    try {
      const account = await client.account();
      console.log(`Account:  ${account.email}`);
      console.log(`Balance:  ${account.balance} credits  (~$${creditsToUsd(account.balance).toFixed(2)})`);
      console.log(`Escrowed: ${account.escrowed} credits (locked in in-flight jobs)`);
    } catch (err) {
      fail(err);
    }
  });

// --- workers ---------------------------------------------------------------

program
  .command('workers')
  .description('List workers on the network.')
  .action(async () => {
    const config = loadConfig();
    const client = new CoordinatorClient(config.coordinatorUrl, config.apiKey);
    try {
      const { workers } = await client.listWorkers();
      if (workers.length === 0) {
        console.log('No workers registered.');
        return;
      }
      for (const w of workers) {
        console.log(
          `${w.name.padEnd(18)}  ${w.status.padEnd(8)}  rep ${String(w.reputation).padStart(3)}  ` +
            `${String(w.priceMultiplier).padStart(5)}x  ${w.adapters.join(',').padEnd(22)}  ` +
            `${w.jobsCompleted}✓ ${w.jobsFailed}✗`,
        );
      }
    } catch (err) {
      fail(err);
    }
  });

// --- stats -----------------------------------------------------------------

program
  .command('stats')
  .description('Show network-wide statistics.')
  .action(async () => {
    const config = loadConfig();
    const client = new CoordinatorClient(config.coordinatorUrl, config.apiKey);
    try {
      const s = await client.stats();
      console.log(`Users:                ${s.users}`);
      console.log(`Workers:              ${s.workers} (${s.workersOnline} online)`);
      console.log(`Jobs queued:          ${s.jobsQueued}`);
      console.log(`Jobs running:         ${s.jobsRunning}`);
      console.log(`Jobs completed:       ${s.jobsCompleted}`);
      console.log(`Credits in circulation: ${s.creditsInCirculation}`);
      console.log(`Tokens metered:       ${s.totalTokensMetered}`);
    } catch (err) {
      fail(err);
    }
  });

// --- adapters --------------------------------------------------------------

program
  .command('adapters')
  .description('Show which agent adapters are installed on this machine.')
  .action(async () => {
    const probe = await probeAdapters();
    for (const [name, available] of Object.entries(probe)) {
      console.log(`${available ? '✓' : '✗'} ${name}`);
    }
  });

program.parseAsync().catch((err) => fail(err));

// --- helpers ---------------------------------------------------------------

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function printJob(job: {
  id: string;
  status: string;
  adapter: string;
  costCredits: number | null;
  resultText: string | null;
  error: string | null;
  tokenUsage: { totalTokens: number; costUsd: number; estimated: boolean } | null;
  verification: { ok: boolean; reasons: string[]; verifiedCostUsd: number } | null;
  outputFiles: JobFile[] | null;
}): void {
  console.log(`Job ${job.id}`);
  console.log(`  Status:  ${job.status}`);
  console.log(`  Adapter: ${job.adapter}`);
  if (job.tokenUsage) {
    const tag = job.tokenUsage.estimated ? ' (estimated)' : '';
    console.log(
      `  Tokens:  ${job.tokenUsage.totalTokens}  ($${job.tokenUsage.costUsd.toFixed(4)}${tag})`,
    );
  }
  if (job.costCredits !== null) console.log(`  Charged: ${job.costCredits} credits`);
  if (job.verification && !job.verification.ok) {
    console.log(`  Usage:   ⚠ flagged — ${job.verification.reasons.join('; ')}`);
  } else if (job.verification) {
    console.log('  Usage:   ✓ verified');
  }
  if (job.error) console.log(`  Error:   ${job.error}`);
  if (job.resultText) {
    console.log('  --- result ---');
    console.log(job.resultText.split('\n').map((l) => `  ${l}`).join('\n'));
  }
  if (job.outputFiles && job.outputFiles.length > 0) {
    console.log(`  --- output files (${job.outputFiles.length}) ---`);
    for (const f of job.outputFiles) console.log(`  ${f.path} (${f.content.length} bytes)`);
  }
}

function fail(err: unknown): never {
  if (err instanceof ApiError) {
    console.error(`Error: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(`Error: ${String(err)}`);
  }
  process.exit(1);
}
