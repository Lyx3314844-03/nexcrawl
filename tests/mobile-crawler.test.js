import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import { Router } from '../src/api/router.js';
import { MobileCrawler } from '../src/runtime/mobile-crawler.js';

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

test('MobileCrawler creates an Appium session, routes screens, and drives element interactions', async (t) => {
  const calls = [];
  const appiumState = {
    sessionId: 'session-1',
    currentScreen: 'home',
    closed: false,
  };

  const server = createServer(async (req, res) => {
    const path = req.url;
    const payload = await readJson(req).catch(() => ({}));
    calls.push({ method: req.method, path, payload });

    if (req.method === 'POST' && path === '/wd/hub/session') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        value: {
          sessionId: appiumState.sessionId,
          capabilities: {
            platformName: 'Android',
          },
        },
      }));
      return;
    }

    if (req.method === 'GET' && path === `/wd/hub/session/${appiumState.sessionId}/source`) {
      res.setHeader('content-type', 'application/json');
      const source = appiumState.currentScreen === 'home'
        ? '<hierarchy><node content-desc="open-details" text="Open details"/></hierarchy>'
        : '<hierarchy><node resource-id="search-input" text="Details screen"/></hierarchy>';
      res.end(JSON.stringify({ value: source }));
      return;
    }

    if (req.method === 'GET' && path === `/wd/hub/session/${appiumState.sessionId}/appium/device/current_activity`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: appiumState.currentScreen === 'home' ? '.HomeActivity' : '.DetailsActivity' }));
      return;
    }

    if (req.method === 'GET' && path === `/wd/hub/session/${appiumState.sessionId}/appium/device/current_package`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: 'com.example.demo' }));
      return;
    }

    if (req.method === 'POST' && path === `/wd/hub/session/${appiumState.sessionId}/element`) {
      res.setHeader('content-type', 'application/json');
      const elementId = payload.value === 'open-details' ? 'element-open' : 'element-search';
      res.end(JSON.stringify({
        value: {
          'element-6066-11e4-a52e-4f735466cecf': elementId,
        },
      }));
      return;
    }

    if (req.method === 'POST' && path === `/wd/hub/session/${appiumState.sessionId}/element/element-open/click`) {
      appiumState.currentScreen = 'details';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: null }));
      return;
    }

    if (req.method === 'POST' && path === `/wd/hub/session/${appiumState.sessionId}/element/element-search/clear`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: null }));
      return;
    }

    if (req.method === 'POST' && path === `/wd/hub/session/${appiumState.sessionId}/element/element-search/value`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: null }));
      return;
    }

    if (req.method === 'POST' && path === `/wd/hub/session/${appiumState.sessionId}/actions`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: null }));
      return;
    }

    if (req.method === 'DELETE' && path === `/wd/hub/session/${appiumState.sessionId}`) {
      appiumState.closed = true;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: null }));
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ value: { message: `unexpected ${req.method} ${path}` } }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const router = new Router()
    .addHandler('/', async (ctx) => {
      await ctx.pushData({ screen: 'home', activity: ctx.screen.activity });
      await ctx.click('id=open-details');
      ctx.enqueueScreen('/details');
    })
    .addHandler('/details', async (ctx) => {
      await ctx.type('id=search-input', 'demo', { clearFirst: true });
      await ctx.swipe('down');
      await ctx.pushData({ screen: 'details', package: ctx.screen.package });
      ctx.stop();
    });

  const crawler = new MobileCrawler({
    name: 'appium-smoke',
    appiumUrl: `http://127.0.0.1:${server.address().port}/wd/hub`,
    router,
    maxScreens: 5,
  });

  const summary = await crawler.run();

  assert.equal(summary.status, 'aborted');
  assert.equal(summary.pages, 2);
  assert.equal(summary.items.length, 2);
  assert.deepEqual(summary.items.map((item) => item.screen), ['home', 'details']);
  assert.equal(summary.interactions, 3);
  assert.equal(appiumState.closed, true);
  assert.ok(calls.some((entry) => entry.path === `/wd/hub/session/${appiumState.sessionId}/actions`));
  assert.ok(calls.some((entry) => entry.path === `/wd/hub/session/${appiumState.sessionId}/element/element-search/value` && entry.payload.text === 'demo'));
});

test('MobileCrawler falls back to POST /source when GET /source is not supported', async (t) => {
  const sessionId = 'session-fallback';
  let sourcePostCalls = 0;

  const server = createServer(async (req, res) => {
    const path = req.url;
    const payload = await readJson(req).catch(() => ({}));

    if (req.method === 'POST' && path === '/wd/hub/session') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        value: {
          sessionId,
          capabilities: { platformName: 'Android' },
        },
      }));
      return;
    }

    if (req.method === 'GET' && path === `/wd/hub/session/${sessionId}/source`) {
      res.statusCode = 405;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: { message: 'GET source unsupported' } }));
      return;
    }

    if (req.method === 'POST' && path === `/wd/hub/session/${sessionId}/source`) {
      sourcePostCalls += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: '<hierarchy><node text="fallback"/></hierarchy>' }));
      return;
    }

    if (req.method === 'DELETE' && path === `/wd/hub/session/${sessionId}`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: null }));
      return;
    }

    if (req.method === 'GET' && path.includes('/appium/device/')) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: { message: 'unsupported' } }));
      return;
    }

    if (req.method === 'POST' && path === `/wd/hub/session/${sessionId}/element`) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        value: {
          'element-6066-11e4-a52e-4f735466cecf': 'fallback-element',
        },
      }));
      return;
    }

    if (payload && path) {
      res.statusCode = 404;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value: { message: `unexpected ${req.method} ${path}` } }));
    }
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const router = new Router().addDefaultHandler(async (ctx) => {
    await ctx.pushData({ source: ctx.source });
    ctx.stop();
  });

  const crawler = new MobileCrawler({
    appiumUrl: `http://127.0.0.1:${server.address().port}/wd/hub`,
    router,
    maxScreens: 1,
  });

  const summary = await crawler.run();
  assert.equal(sourcePostCalls, 1);
  assert.equal(summary.items[0].source.includes('fallback'), true);
});
