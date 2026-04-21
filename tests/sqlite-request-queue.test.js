import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteRequestQueue } from '../src/runtime/sqlite-request-queue.js';

test('sqlite request queue skips already-seen urls across runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-sqlite-request-queue-'));
  const dbPath = join(root, '.omnicrawl', 'control-plane.sqlite');

  const firstQueue = new SqliteRequestQueue({
    dbPath,
    jobId: 'job-seen-a',
    config: {
      seenSet: {
        enabled: true,
        id: 'catalog-prod',
      },
    },
  });

  try {
    await firstQueue.init();
    const firstEnqueue = await firstQueue.enqueue({
      url: 'https://example.com/catalog/42',
      priority: 100,
    });
    assert.equal(firstEnqueue.added, true);

    const firstLease = await firstQueue.dequeue();
    assert.ok(firstLease);
    await firstQueue.markHandled(firstLease.uniqueKey, {
      finalUrl: firstLease.url,
      responseStatus: 200,
    });
    assert.equal(firstQueue.summary().seenSet.seenCount, 1);

    const secondQueue = new SqliteRequestQueue({
      dbPath,
      jobId: 'job-seen-b',
      config: {
        seenSet: {
          enabled: true,
          id: 'catalog-prod',
        },
      },
    });

    try {
      await secondQueue.init();
      const duplicate = await secondQueue.enqueue({
        url: 'https://example.com/catalog/42',
        priority: 100,
      });
      assert.equal(duplicate.added, false);
      assert.equal(duplicate.reason, 'already-seen');
      assert.equal(secondQueue.summary().seenSet.seenCount, 1);
    } finally {
      secondQueue.close();
    }
  } finally {
    firstQueue.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('sqlite request queue honors discovery lane limits and windows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-sqlite-request-lanes-'));
  const dbPath = join(root, '.omnicrawl', 'control-plane.sqlite');
  const queue = new SqliteRequestQueue({
    dbPath,
    jobId: 'job-lanes',
    config: {
      laneConfigs: {
        detail: {
          maxInProgress: 1,
          budgetWindowMs: 1000,
          maxRequestsPerWindow: 1,
        },
      },
    },
  });

  try {
    await queue.init();
    await queue.enqueue({
      url: 'https://example.com/product/1',
      priority: 100,
      metadata: { kind: 'detail' },
    });
    await queue.enqueue({
      url: 'https://example.com/product/2',
      priority: 90,
      metadata: { kind: 'detail' },
    });
    await queue.enqueue({
      url: 'https://example.com/catalog?page=2',
      priority: 80,
      metadata: { kind: 'pagination' },
    });

    const first = await queue.dequeue({
      laneConfigs: queue.config.laneConfigs,
      activeLanes: new Map(),
      recentLaneDispatches: new Map(),
    });
    assert.equal(first?.url, 'https://example.com/product/1');
    assert.equal(first?.laneKey, 'detail');

    const second = await queue.dequeue({
      laneConfigs: queue.config.laneConfigs,
      activeLanes: new Map([['detail', 1]]),
      recentLaneDispatches: new Map([['detail', [Date.now()]]]),
    });
    assert.equal(second?.url, 'https://example.com/catalog?page=2');
    assert.equal(second?.laneKey, 'pagination');

    const third = await queue.dequeue({
      laneConfigs: queue.config.laneConfigs,
      activeLanes: new Map(),
      recentLaneDispatches: new Map(),
    });
    assert.equal(third?.url, 'https://example.com/product/2');
    assert.equal(third?.laneKey, 'detail');
  } finally {
    queue.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('sqlite request queue persists userData and explicit laneKey', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-sqlite-request-userdata-'));
  const dbPath = join(root, '.omnicrawl', 'control-plane.sqlite');
  const queue = new SqliteRequestQueue({
    dbPath,
    jobId: 'job-userdata',
    config: {},
  });

  try {
    await queue.init();
    await queue.enqueue({
      url: 'https://example.com/product/9',
      priority: 100,
      laneKey: 'detail',
      userData: { discoveryKind: 'detail', shard: 'alpha' },
      metadata: { kind: 'detail' },
    });

    const leased = await queue.dequeue();
    assert.ok(leased);
    assert.equal(leased.laneKey, 'detail');
    assert.deepEqual(leased.userData, { discoveryKind: 'detail', shard: 'alpha' });
    assert.equal(leased.metadata.kind, 'detail');
  } finally {
    queue.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('sqlite request queue can coordinate lane budgets from backend state only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-sqlite-backend-lanes-'));
  const dbPath = join(root, '.omnicrawl', 'control-plane.sqlite');
  const queue = new SqliteRequestQueue({
    dbPath,
    jobId: 'job-backend-lanes',
    config: {
      hostAwareScheduling: false,
      laneConfigs: {
        detail: {
          maxInProgress: 1,
        },
      },
    },
  });

  try {
    await queue.init();
    await queue.enqueue({
      url: 'https://example.com/product/1',
      priority: 100,
      metadata: { kind: 'detail' },
    });
    await queue.enqueue({
      url: 'https://example.com/product/2',
      priority: 90,
      metadata: { kind: 'detail' },
    });
    await queue.enqueue({
      url: 'https://example.com/catalog?page=2',
      priority: 80,
      metadata: { kind: 'pagination' },
    });

    const first = await queue.dequeue({
      useBackendFrontierState: true,
      laneConfigs: queue.config.laneConfigs,
    });
    assert.equal(first?.url, 'https://example.com/product/1');

    const second = await queue.dequeue({
      useBackendFrontierState: true,
      laneConfigs: queue.config.laneConfigs,
    });
    assert.equal(second?.url, 'https://example.com/catalog?page=2');
    assert.equal(second?.laneKey, 'pagination');
  } finally {
    queue.close();
    await rm(root, { recursive: true, force: true });
  }
});
