import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RequestQueue, getRequestGroupKey } from '../src/runtime/request-queue.js';

test('request queue dedupes normalized urls and reclaims interrupted work', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-'));

  try {
    const queue = new RequestQueue({
      runDir,
      config: {
        sortQueryParams: true,
        stripHash: true,
      },
    });
    await queue.init();

    const first = await queue.enqueue({
      url: 'https://example.com/search?b=2&a=1#section',
      depth: 0,
      parentUrl: null,
    });
    assert.equal(first.added, true);

    const duplicate = await queue.enqueue({
      url: 'https://example.com/search?a=1&b=2',
      depth: 0,
      parentUrl: null,
    });
    assert.equal(duplicate.added, false);
    assert.equal(queue.summary().totalCount, 1);

    const leased = await queue.dequeue();
    assert.ok(leased);
    assert.equal(leased.status, 'inProgress');

    const resumedQueue = new RequestQueue({
      runDir,
      config: {
        sortQueryParams: true,
        stripHash: true,
      },
    });
    await resumedQueue.init();
    assert.equal(resumedQueue.summary().pendingCount, 1);
    assert.equal(resumedQueue.summary().reclaimedCount, 1);

    const reclaimed = await resumedQueue.dequeue();
    assert.ok(reclaimed);
    assert.equal(reclaimed.uniqueKey, leased.uniqueKey);

    await resumedQueue.markHandled(reclaimed.uniqueKey, {
      finalUrl: reclaimed.url,
      responseStatus: 200,
    });

    const summary = resumedQueue.summary();
    assert.equal(summary.pendingCount, 0);
    assert.equal(summary.handledCount, 1);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue keeps POST requests with different bodies distinct by default', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-body-'));

  try {
    const queue = new RequestQueue({ runDir });
    await queue.init();

    const first = await queue.enqueue({
      url: 'https://example.com/graphql',
      method: 'POST',
      body: '{"page":1}',
    });
    const second = await queue.enqueue({
      url: 'https://example.com/graphql',
      method: 'POST',
      body: '{"page":2}',
    });

    assert.equal(first.added, true);
    assert.equal(second.added, true);
    assert.notEqual(first.request.uniqueKey, second.request.uniqueKey);
    assert.equal(queue.summary().totalCount, 2);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue skips saturated hosts while preserving priority ordering', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-frontier-'));

  try {
    const queue = new RequestQueue({
      runDir,
      config: {
        hostAwareScheduling: true,
        maxInProgressPerHost: 1,
      },
    });
    await queue.init();

    await queue.enqueue({
      url: 'https://alpha.example.com/a-1',
      depth: 0,
      parentUrl: null,
      priority: 100,
    });
    await queue.enqueue({
      url: 'https://alpha.example.com/a-2',
      depth: 0,
      parentUrl: null,
      priority: 90,
    });
    await queue.enqueue({
      url: 'https://beta.example.com/b-1',
      depth: 0,
      parentUrl: null,
      priority: 80,
    });

    const first = await queue.dequeue({
      activeHosts: {},
      hostAwareScheduling: true,
      maxInProgressPerHost: 1,
    });
    assert.equal(first.url, 'https://alpha.example.com/a-1');

    const second = await queue.dequeue({
      activeHosts: { 'alpha.example.com': 1 },
      hostAwareScheduling: true,
      maxInProgressPerHost: 1,
    });
    assert.equal(second.url, 'https://beta.example.com/b-1');

    await queue.markHandled(first.uniqueKey, {
      finalUrl: first.url,
      responseStatus: 200,
    });

    const third = await queue.dequeue({
      activeHosts: {},
      hostAwareScheduling: true,
      maxInProgressPerHost: 1,
    });
    assert.equal(third.url, 'https://alpha.example.com/a-2');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue strips tracking params and dequeues higher priority items first', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-priority-'));

  try {
    const queue = new RequestQueue({
      runDir,
      config: {
        sortQueryParams: true,
        stripHash: true,
        dropQueryParams: ['fbclid', 'gclid'],
        dropQueryParamPatterns: ['^utm_'],
      },
    });
    await queue.init();

    const lowPriority = await queue.enqueue({
      url: 'https://example.com/list?page=2&utm_source=newsletter',
      priority: 10,
      depth: 2,
    });
    assert.equal(lowPriority.added, true);

    const duplicate = await queue.enqueue({
      url: 'https://example.com/list?utm_medium=email&page=2',
      priority: 20,
      depth: 2,
    });
    assert.equal(duplicate.added, false);

    const highPriority = await queue.enqueue({
      url: 'https://example.com/detail?id=42&fbclid=abc123',
      priority: 90,
      depth: 1,
    });
    assert.equal(highPriority.added, true);

    const first = await queue.dequeue();
    const second = await queue.dequeue();

    assert.equal(first?.url, 'https://example.com/detail?id=42&fbclid=abc123');
    assert.equal(first?.priority, 90);
    assert.equal(second?.url, 'https://example.com/list?page=2&utm_source=newsletter');
    assert.equal(second?.priority, 10);
    assert.equal(queue.summary().totalCount, 2);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue supports origin grouping and window budgets', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-budget-'));

  try {
    const queue = new RequestQueue({
      runDir,
      config: {
        groupBy: 'origin',
        budgetWindowMs: 1000,
        maxRequestsPerWindow: 1,
      },
    });
    await queue.init();

    await queue.enqueue({
      url: 'http://127.0.0.1:3001/a-1',
      priority: 100,
    });
    await queue.enqueue({
      url: 'http://127.0.0.1:3001/a-2',
      priority: 90,
    });
    await queue.enqueue({
      url: 'http://127.0.0.1:3002/b-1',
      priority: 80,
    });

    const first = await queue.dequeue({
      groupBy: 'origin',
      budgetWindowMs: 1000,
      maxRequestsPerWindow: 1,
      recentGroupDispatches: new Map(),
    });
    assert.equal(first?.url, 'http://127.0.0.1:3001/a-1');

    const second = await queue.dequeue({
      groupBy: 'origin',
      budgetWindowMs: 1000,
      maxRequestsPerWindow: 1,
      recentGroupDispatches: new Map([
        ['http://127.0.0.1:3001', [Date.now()]],
      ]),
    });
    assert.equal(second?.url, 'http://127.0.0.1:3002/b-1');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue skips groups that are in runtime backoff', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-backoff-'));

  try {
    const queue = new RequestQueue({
      runDir,
      config: {
        groupBy: 'origin',
      },
    });
    await queue.init();

    await queue.enqueue({
      url: 'http://127.0.0.1:3201/a-1',
      priority: 100,
    });
    await queue.enqueue({
      url: 'http://127.0.0.1:3201/a-2',
      priority: 90,
    });
    await queue.enqueue({
      url: 'http://127.0.0.1:3202/b-1',
      priority: 80,
    });

    const blockedUntil = Date.now() + 1_000;
    const first = await queue.dequeue({
      groupBy: 'origin',
      blockedGroups: new Map([
        ['http://127.0.0.1:3201', blockedUntil],
      ]),
    });
    assert.equal(first?.url, 'http://127.0.0.1:3202/b-1');

    const second = await queue.dequeue({
      groupBy: 'origin',
      blockedGroups: new Map(),
    });
    assert.equal(second?.url, 'http://127.0.0.1:3201/a-1');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue supports registrable-domain grouping', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-registrable-'));

  try {
    assert.equal(getRequestGroupKey('https://a.api.example.co.uk/page', 'registrableDomain'), 'example.co.uk');
    assert.equal(getRequestGroupKey('https://b.shop.example.com/page', 'registrableDomain'), 'example.com');
    assert.equal(getRequestGroupKey('http://127.0.0.1:3100/page', 'registrableDomain'), '127.0.0.1');

    const queue = new RequestQueue({
      runDir,
      config: {
        groupBy: 'registrableDomain',
        maxInProgressPerGroup: 1,
      },
    });
    await queue.init();

    await queue.enqueue({
      url: 'https://a.api.example.co.uk/a-1',
      priority: 100,
    });
    await queue.enqueue({
      url: 'https://b.shop.example.co.uk/a-2',
      priority: 90,
    });
    await queue.enqueue({
      url: 'https://other.example.com/b-1',
      priority: 80,
    });

    const first = await queue.dequeue({
      groupBy: 'registrableDomain',
      maxInProgressPerGroup: 1,
      activeGroups: {},
    });
    assert.equal(first?.groupKey, 'example.co.uk');

    const second = await queue.dequeue({
      groupBy: 'registrableDomain',
      maxInProgressPerGroup: 1,
      activeGroups: { 'example.co.uk': 1 },
    });
    assert.equal(second?.groupKey, 'example.com');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue supports registrable-domain grouping across sibling subdomains', async () => {
  const runDir = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-registrable-'));

  try {
    const queue = new RequestQueue({
      runDir,
      config: {
        groupBy: 'registrableDomain',
        hostAwareScheduling: true,
        maxInProgressPerGroup: 1,
      },
    });
    await queue.init();

    await queue.enqueue({
      url: 'https://shop.example.co.uk/listing',
      priority: 100,
    });
    await queue.enqueue({
      url: 'https://api.example.co.uk/feed',
      priority: 90,
    });
    await queue.enqueue({
      url: 'https://news.example.com/front-page',
      priority: 80,
    });

    const first = await queue.dequeue({
      groupBy: 'registrableDomain',
      hostAwareScheduling: true,
      maxInProgressPerGroup: 1,
      activeGroups: new Map(),
    });
    assert.equal(first?.groupKey, 'example.co.uk');

    const second = await queue.dequeue({
      groupBy: 'registrableDomain',
      hostAwareScheduling: true,
      maxInProgressPerGroup: 1,
      activeGroups: new Map([
        ['example.co.uk', 1],
      ]),
    });
    assert.equal(second?.url, 'https://news.example.com/front-page');
    assert.equal(second?.groupKey, 'example.com');
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test('request queue skips cross-run seen urls when seen-set is enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-request-queue-seen-'));
  const runDirA = join(root, 'runs', 'job-a');
  const runDirB = join(root, 'runs', 'job-b');

  try {
    const firstQueue = new RequestQueue({
      runDir: runDirA,
      config: {
        seenSet: {
          enabled: true,
          id: 'products-prod',
        },
      },
    });
    await firstQueue.init();

    const firstEnqueue = await firstQueue.enqueue({
      url: 'https://example.com/products/42',
      depth: 0,
    });
    assert.equal(firstEnqueue.added, true);

    const firstLease = await firstQueue.dequeue();
    assert.ok(firstLease);
    await firstQueue.markHandled(firstLease.uniqueKey, {
      finalUrl: firstLease.url,
      responseStatus: 200,
    });
    assert.equal(firstQueue.summary().seenSet.seenCount, 1);

    const secondQueue = new RequestQueue({
      runDir: runDirB,
      config: {
        seenSet: {
          enabled: true,
          id: 'products-prod',
        },
      },
    });
    await secondQueue.init();

    const duplicateAcrossRuns = await secondQueue.enqueue({
      url: 'https://example.com/products/42',
      depth: 0,
    });
    assert.equal(duplicateAcrossRuns.added, false);
    assert.equal(duplicateAcrossRuns.reason, 'already-seen');
    assert.equal(secondQueue.summary().seenSet.seenCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
