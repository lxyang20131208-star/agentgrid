import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator/index.js';

/**
 * The federated view aggregates a coordinator with its peers into one
 * read-only roll-up. Each coordinator keeps its own ledger.
 */
test('getFederation rolls up a coordinator and its peer', async () => {
  // Start the peer first so its URL is known when configuring the primary.
  const peer = new Coordinator({ port: 0, dbPath: ':memory:', quiet: true });
  await peer.start();
  const primary = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    quiet: true,
    peers: [peer.url],
  });
  await primary.start();

  try {
    peer.register('a@peer.example');
    peer.register('b@peer.example');
    primary.register('c@primary.example');

    const fed = await primary.getFederation();
    assert.equal(fed.coordinators.length, 2, 'own coordinator plus one peer');
    assert.ok(fed.coordinators.every((c) => c.online), 'both coordinators online');
    assert.equal(fed.aggregate.users, 3, 'user counts are summed across the federation');
  } finally {
    await primary.stop();
    await peer.stop();
  }
});

test('an offline peer is reported but does not break the view', async () => {
  const primary = new Coordinator({
    port: 0,
    dbPath: ':memory:',
    quiet: true,
    peers: ['http://127.0.0.1:9'], // nothing listening here
  });
  await primary.start();
  try {
    primary.register('solo@primary.example');
    const fed = await primary.getFederation();
    assert.equal(fed.coordinators.length, 2);
    const offline = fed.coordinators.find((c) => c.url === 'http://127.0.0.1:9');
    assert.ok(offline && !offline.online, 'the unreachable peer is marked offline');
    assert.equal(fed.aggregate.users, 1, 'aggregate still reflects the reachable coordinator');
  } finally {
    await primary.stop();
  }
});
