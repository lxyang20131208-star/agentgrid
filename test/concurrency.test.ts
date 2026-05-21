import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator/index.js';
import { Worker } from '../src/worker/index.js';
import { CoordinatorClient } from '../src/client/index.js';

/**
 * A single worker with capacity > 1 should pick up and finish several jobs.
 */
test('a capacity-3 worker completes three jobs', async () => {
  const coordinator = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    signupGrant: 100_000,
    quiet: true,
  });
  await coordinator.start();

  const buyer = coordinator.register('buyer@example.com');
  const seller = coordinator.register('seller@example.com');

  const worker = new Worker({
    coordinatorUrls: [coordinator.url],
    apiKey: seller.apiKey,
    name: 'wide-worker',
    adapters: ['mock'],
    capacity: 3,
    quiet: true,
    autoReconnect: false,
  });
  await worker.start();

  const client = new CoordinatorClient(coordinator.url, buyer.apiKey);
  try {
    // Submit three jobs back-to-back.
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const { job } = await client.submitJob({
        adapter: 'mock',
        prompt: `job number ${i}`,
        inputFiles: [],
        maxCredits: 5_000,
      });
      ids.push(job.id);
    }

    for (const id of ids) {
      const done = await client.waitForJob(id, 30_000);
      assert.equal(done.status, 'completed', `job ${id} completed`);
      assert.equal(done.workerId, worker.id, 'all jobs ran on the one worker');
    }

    const stats = await client.stats();
    assert.equal(stats.jobsCompleted, 3);
  } finally {
    await worker.stop();
    await coordinator.stop();
  }
});

test('a capacity-1 worker still serially completes multiple jobs', async () => {
  const coordinator = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    signupGrant: 100_000,
    quiet: true,
  });
  await coordinator.start();
  const buyer = coordinator.register('buyer@example.com');
  const seller = coordinator.register('seller@example.com');
  const worker = new Worker({
    coordinatorUrls: [coordinator.url],
    apiKey: seller.apiKey,
    name: 'narrow-worker',
    adapters: ['mock'],
    capacity: 1,
    quiet: true,
    autoReconnect: false,
  });
  await worker.start();
  const client = new CoordinatorClient(coordinator.url, buyer.apiKey);
  try {
    const a = await client.submitJob({ adapter: 'mock', prompt: 'a', inputFiles: [], maxCredits: 5_000 });
    const b = await client.submitJob({ adapter: 'mock', prompt: 'b', inputFiles: [], maxCredits: 5_000 });
    assert.equal((await client.waitForJob(a.job.id, 30_000)).status, 'completed');
    assert.equal((await client.waitForJob(b.job.id, 30_000)).status, 'completed');
  } finally {
    await worker.stop();
    await coordinator.stop();
  }
});
