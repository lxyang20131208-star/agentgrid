import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator/index.js';
import { Worker } from '../src/worker/index.js';
import { CoordinatorClient } from '../src/client/index.js';

/**
 * Price competition: when two workers can do a job, the cheaper one wins.
 */
test('a job is routed to the cheaper of two competing workers', async () => {
  const coordinator = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    signupGrant: 100_000,
    quiet: true,
  });
  await coordinator.start();

  const buyer = coordinator.register('buyer@example.com');
  const sellerA = coordinator.register('expensive@example.com');
  const sellerB = coordinator.register('cheap@example.com');

  const expensive = new Worker({
    coordinatorUrl: coordinator.url,
    apiKey: sellerA.apiKey,
    name: 'expensive-worker',
    adapters: ['mock'],
    priceMultiplier: 2.0,
    quiet: true,
    autoReconnect: false,
  });
  const cheap = new Worker({
    coordinatorUrl: coordinator.url,
    apiKey: sellerB.apiKey,
    name: 'cheap-worker',
    adapters: ['mock'],
    priceMultiplier: 0.5,
    quiet: true,
    autoReconnect: false,
  });
  await expensive.start();
  await cheap.start();

  const client = new CoordinatorClient(coordinator.url, buyer.apiKey);
  try {
    const { job } = await client.submitJob({
      adapter: 'mock',
      prompt: 'cheap or expensive?',
      inputFiles: [],
      maxCredits: 50_000,
    });
    const done = await client.waitForJob(job.id, 30_000);
    assert.equal(done.status, 'completed');
    assert.equal(
      done.workerId,
      cheap.id,
      'the cheaper worker won the job',
    );
  } finally {
    await expensive.stop();
    await cheap.stop();
    await coordinator.stop();
  }
});

/**
 * A buyer can refuse workers priced above a ceiling. If the only worker is too
 * expensive, the job simply waits in the queue.
 */
test('maxPriceMultiplier keeps a job away from an over-priced worker', async () => {
  const coordinator = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    signupGrant: 100_000,
    quiet: true,
  });
  await coordinator.start();

  const buyer = coordinator.register('buyer@example.com');
  const seller = coordinator.register('pricey@example.com');

  const pricey = new Worker({
    coordinatorUrl: coordinator.url,
    apiKey: seller.apiKey,
    name: 'pricey-worker',
    adapters: ['mock'],
    priceMultiplier: 3.0,
    quiet: true,
    autoReconnect: false,
  });
  await pricey.start();

  const client = new CoordinatorClient(coordinator.url, buyer.apiKey);
  try {
    const { job } = await client.submitJob({
      adapter: 'mock',
      prompt: 'only cheap workers, please',
      inputFiles: [],
      maxCredits: 50_000,
      maxPriceMultiplier: 1.0,
    });
    // Give the matcher time to (not) dispatch it.
    await new Promise((r) => setTimeout(r, 3_000));
    const { job: still } = await client.getJob(job.id);
    assert.equal(
      still.status,
      'queued',
      'the job stays queued because no worker is within budget',
    );
  } finally {
    await pricey.stop();
    await coordinator.stop();
  }
});
