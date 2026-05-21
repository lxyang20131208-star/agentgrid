import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator/index.js';
import { Worker } from '../src/worker/index.js';
import { CoordinatorClient } from '../src/client/index.js';

/**
 * End-to-end: a buyer submits a job, a worker (using the always-available
 * `mock` adapter) executes it, and the coordinator settles credits between
 * them. Exercises the whole stack with no API keys or token spend.
 */
test('a job flows from buyer to worker and credits settle', async () => {
  const coordinator = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    signupGrant: 10_000,
    quiet: true,
  });
  await coordinator.start();
  const url = coordinator.url;

  // Two accounts: one buys compute, one sells it.
  const buyer = coordinator.register('buyer@example.com');
  const seller = coordinator.register('seller@example.com');

  const worker = new Worker({
    coordinatorUrl: url,
    apiKey: seller.apiKey,
    name: 'test-worker',
    adapters: ['mock'],
    quiet: true,
    autoReconnect: false,
  });
  await worker.start();

  const client = new CoordinatorClient(url, buyer.apiKey);

  try {
    const { job } = await client.submitJob({
      adapter: 'mock',
      prompt: 'Summarise the project README.',
      inputFiles: [{ path: 'README.md', content: '# Demo\nHello AgentGrid.' }],
      maxCredits: 5_000,
    });
    assert.equal(job.status, 'queued');

    const done = await client.waitForJob(job.id, 30_000);
    assert.equal(done.status, 'completed', `job ended ${done.status}: ${done.error}`);
    assert.ok(done.resultText?.includes('[mock]'), 'result carries the mock marker');
    assert.ok(done.tokenUsage, 'token usage was metered');
    assert.ok(done.tokenUsage!.totalTokens > 0, 'tokens were counted');
    assert.ok(done.costCredits !== null && done.costCredits > 0, 'job was charged');

    // The worker created MOCK_RESULT.md, which must come back as an output file.
    assert.ok(
      done.outputFiles?.some((f) => f.path === 'MOCK_RESULT.md'),
      'output file was collected',
    );

    // Credits moved: buyer paid, seller earned, conservation holds.
    const buyerAccount = coordinator.getAccountInfo(buyer.user.id);
    const sellerAccount = coordinator.getAccountInfo(seller.user.id);
    assert.equal(
      buyerAccount.balance,
      10_000 - done.costCredits!,
      'buyer balance fell by exactly the charged amount',
    );
    assert.equal(
      sellerAccount.balance,
      10_000 + done.costCredits!,
      'seller balance rose by exactly the charged amount',
    );
  } finally {
    await worker.stop();
    await coordinator.stop();
  }
});

test('submitting a job with no budget is rejected', async () => {
  const coordinator = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    signupGrant: 100,
    quiet: true,
  });
  await coordinator.start();
  try {
    const buyer = coordinator.register('broke@example.com');
    const client = new CoordinatorClient(coordinator.url, buyer.apiKey);
    await assert.rejects(
      client.submitJob({
        adapter: 'mock',
        prompt: 'do something expensive',
        inputFiles: [],
        maxCredits: 1_000_000,
      }),
      /insufficient credits/,
    );
  } finally {
    await coordinator.stop();
  }
});

test('the coordinator reports network stats', async () => {
  const coordinator = new Coordinator({ port: 0, dbPath: ':memory:', quiet: true });
  await coordinator.start();
  try {
    coordinator.register('a@example.com');
    coordinator.register('b@example.com');
    const client = new CoordinatorClient(coordinator.url);
    const stats = await client.stats();
    assert.equal(stats.users, 2);
    assert.equal(stats.jobsCompleted, 0);
    const health = await client.health();
    assert.equal(health.ok, true);
  } finally {
    await coordinator.stop();
  }
});
