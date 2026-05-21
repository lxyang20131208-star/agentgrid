import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator/index.js';
import { Worker } from '../src/worker/index.js';
import { CoordinatorClient } from '../src/client/index.js';

/** Spin up a coordinator + one mock worker + a buyer client. */
async function setup(acceptanceWindowMs: number) {
  const coordinator = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    signupGrant: 100_000,
    acceptanceWindowMs,
    quiet: true,
  });
  await coordinator.start();
  const buyer = coordinator.register('buyer@example.com');
  const seller = coordinator.register('seller@example.com');
  const worker = new Worker({
    coordinatorUrls: [coordinator.url],
    apiKey: seller.apiKey,
    name: 'mock-worker',
    adapters: ['mock'],
    quiet: true,
    autoReconnect: false,
  });
  await worker.start();
  const client = new CoordinatorClient(coordinator.url, buyer.apiKey);
  return { coordinator, buyer, seller, worker, client };
}

test('with an acceptance window, a finished job is delivered then accepted', async () => {
  const { coordinator, buyer, seller, worker, client } = await setup(60_000);
  try {
    const { job } = await client.submitJob({
      adapter: 'mock',
      prompt: 'do the thing',
      inputFiles: [],
      maxCredits: 5_000,
    });
    const delivered = await client.waitForJob(job.id, 30_000);
    assert.equal(delivered.status, 'delivered', 'job waits for buyer acceptance');

    // The worker has not been paid yet — credits are still escrowed.
    assert.equal(coordinator.getAccountInfo(seller.user.id).balance, 100_000);

    const { job: accepted } = await client.acceptJob(job.id);
    assert.equal(accepted.status, 'completed');
    assert.ok(
      coordinator.getAccountInfo(seller.user.id).balance > 100_000,
      'worker is paid once the buyer accepts',
    );
    assert.ok(coordinator.getAccountInfo(buyer.user.id).balance < 100_000);
  } finally {
    await worker.stop();
    await coordinator.stop();
  }
});

test('a disputed job, resolved for the buyer, refunds in full', async () => {
  const { coordinator, buyer, seller, worker, client } = await setup(60_000);
  try {
    const { job } = await client.submitJob({
      adapter: 'mock',
      prompt: 'do the thing',
      inputFiles: [],
      maxCredits: 5_000,
    });
    await client.waitForJob(job.id, 30_000);

    const { job: disputed } = await client.disputeJob(job.id);
    assert.equal(disputed.status, 'disputed');

    const { job: resolved } = await client.resolveJob(
      job.id,
      'buyer',
      coordinator.adminKey,
    );
    assert.equal(resolved.status, 'completed');
    assert.equal(resolved.resolution, 'buyer');
    assert.equal(
      coordinator.getAccountInfo(buyer.user.id).balance,
      100_000,
      'buyer is fully refunded',
    );
    assert.equal(
      coordinator.getAccountInfo(seller.user.id).balance,
      100_000,
      'worker is not paid for a lost dispute',
    );
  } finally {
    await worker.stop();
    await coordinator.stop();
  }
});

test('a delivered job auto-settles once the window elapses', async () => {
  const { coordinator, seller, worker, client } = await setup(800);
  try {
    const { job } = await client.submitJob({
      adapter: 'mock',
      prompt: 'do the thing',
      inputFiles: [],
      maxCredits: 5_000,
    });
    await client.waitForJob(job.id, 30_000);
    // Wait past the window plus one sweep interval.
    await new Promise((r) => setTimeout(r, 4_000));
    const { job: settled } = await client.getJob(job.id);
    assert.equal(settled.status, 'completed', 'auto-accepted after the window');
    assert.ok(coordinator.getAccountInfo(seller.user.id).balance > 100_000);
  } finally {
    await worker.stop();
    await coordinator.stop();
  }
});

test('disputes are rejected when no acceptance window is configured', async () => {
  const { coordinator, worker, client } = await setup(0);
  try {
    const { job } = await client.submitJob({
      adapter: 'mock',
      prompt: 'do the thing',
      inputFiles: [],
      maxCredits: 5_000,
    });
    const done = await client.waitForJob(job.id, 30_000);
    assert.equal(done.status, 'completed', 'settles immediately with no window');
    await assert.rejects(client.disputeJob(job.id), /disputes are disabled/);
  } finally {
    await worker.stop();
    await coordinator.stop();
  }
});
