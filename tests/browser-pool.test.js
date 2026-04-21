import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OmniCrawler } from '../src/api/omnicrawler.js';
import { buildPlaywrightProxyOptions, normalizeWaitUntilForBackend } from '../src/runtime/browser-pool.js';
import { normalizeBrowserEngine } from '../src/runtime/browser-backend.js';
import { getBrowserPoolSnapshot } from '../src/runtime/browser-pool.js';
import { fetchWithBrowser, closeBrowser } from '../src/fetchers/browser-fetcher.js';

test('browser pool normalizes waitUntil for playwright-compatible backends', () => {
  assert.equal(normalizeWaitUntilForBackend('playwright', 'networkidle2'), 'networkidle');
  assert.equal(normalizeWaitUntilForBackend('playwright', 'networkidle0'), 'networkidle');
  assert.equal(normalizeWaitUntilForBackend('playwright', 'load'), 'load');
  assert.equal(normalizeWaitUntilForBackend('puppeteer', 'networkidle2'), 'networkidle2');
});

test('browser pool builds playwright proxy launch options from proxy config', () => {
  assert.deepEqual(
    buildPlaywrightProxyOptions({
      server: 'http://proxy.local:8080',
      username: 'alice',
      password: 'secret',
      bypass: ['localhost', '.internal'],
    }),
    {
      server: 'http://proxy.local:8080',
      username: 'alice',
      password: 'secret',
      bypass: 'localhost,.internal',
    },
  );

  assert.equal(buildPlaywrightProxyOptions(null), undefined);
});

test('browser backend engine normalization defaults to auto and resolves aliases', () => {
  assert.equal(normalizeBrowserEngine(undefined), 'auto');
  assert.equal(normalizeBrowserEngine('default'), 'auto');
  assert.equal(normalizeBrowserEngine('pw'), 'playwright');
  assert.equal(normalizeBrowserEngine('pptr'), 'puppeteer');
});

test('browser pool closes only the targeted namespace', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<html><head><title>${req.url}</title></head><body>${req.url}</body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const namespaceA = 'test-browser-pool-a';
  const namespaceB = 'test-browser-pool-b';

  try {
    await fetchWithBrowser(
      { url: `${baseUrl}/a`, method: 'GET', headers: {} },
      { headless: true, waitUntil: 'load', pool: { namespace: namespaceA } },
    );
    await fetchWithBrowser(
      { url: `${baseUrl}/b`, method: 'GET', headers: {} },
      { headless: true, waitUntil: 'load', pool: { namespace: namespaceB } },
    );

    const before = getBrowserPoolSnapshot();
    assert.ok(before.items.some((item) => item.key.includes(namespaceA)));
    assert.ok(before.items.some((item) => item.key.includes(namespaceB)));

    await closeBrowser({ namespace: namespaceA, force: true });

    const afterFirstClose = getBrowserPoolSnapshot();
    assert.equal(afterFirstClose.items.some((item) => item.key.includes(namespaceA)), false);
    assert.ok(afterFirstClose.items.some((item) => item.key.includes(namespaceB)));

    await closeBrowser({ namespace: namespaceB, force: true });

    const afterSecondClose = getBrowserPoolSnapshot();
    assert.equal(afterSecondClose.items.some((item) => item.key.includes(namespaceA)), false);
    assert.equal(afterSecondClose.items.some((item) => item.key.includes(namespaceB)), false);
  } finally {
    await closeBrowser({ namespace: namespaceA, force: true }).catch(() => {});
    await closeBrowser({ namespace: namespaceB, force: true }).catch(() => {});
    server.close();
    await once(server, 'close');
  }
});

test('OmniCrawler teardown only closes its own browser namespace', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<html><head><title>${req.url}</title></head><body>${req.url}</body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const firstRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-pool-a-'));
  const secondRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-browser-pool-b-'));

  try {
    await fetchWithBrowser(
      { url: `${baseUrl}/teardown-a`, method: 'GET', headers: {} },
      { headless: true, waitUntil: 'load', pool: { namespace: firstRoot } },
    );
    await fetchWithBrowser(
      { url: `${baseUrl}/teardown-b`, method: 'GET', headers: {} },
      { headless: true, waitUntil: 'load', pool: { namespace: secondRoot } },
    );

    const before = getBrowserPoolSnapshot();
    assert.equal(before.size, 2);

    const crawler = new OmniCrawler({ name: 'browser-pool-scope', projectRoot: firstRoot });
    crawler._mode = 'browser';
    await crawler.teardown();

    const after = getBrowserPoolSnapshot();
    assert.equal(after.size, 1);
  } finally {
    await closeBrowser({ namespace: firstRoot, force: true }).catch(() => {});
    await closeBrowser({ namespace: secondRoot, force: true }).catch(() => {});
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
    server.close();
    await once(server, 'close');
  }
});
