import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { SqliteJobStore } from '../src/runtime/sqlite-job-store.js';

test('sqlite job store reclaims expired worker leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-sqlite-jobs-'));
  const store = new SqliteJobStore({
    dbPath: join(root, '.omnicrawl', 'control-plane.sqlite'),
  });

  try {
    await store.init();

    const workflow = {
      name: 'lease-reclaim',
      seedUrls: ['https://example.com'],
      mode: 'http',
      concurrency: 1,
      maxDepth: 0,
      extract: [],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    };

    const queued = store.createQueuedWorkflow({
      workflow,
      source: 'unit',
      metadata: { trigger: 'unit-test' },
    });

    const firstLease = store.claimNextQueuedJob({
      workerId: 'worker-a',
      leaseTtlMs: 30,
    });

    assert.ok(firstLease);
    assert.equal(firstLease.id, queued.id);
    assert.equal(firstLease.status, 'running');
    assert.equal(firstLease.lease.owner, 'worker-a');

    await sleep(50);

    const reclaimed = store.claimNextQueuedJob({
      workerId: 'worker-b',
      leaseTtlMs: 30,
    });

    assert.ok(reclaimed);
    assert.equal(reclaimed.id, queued.id);
    assert.equal(reclaimed.status, 'running');
    assert.equal(reclaimed.lease.owner, 'worker-b');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
