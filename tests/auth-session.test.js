import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAuthHandler } from '../src/middleware/auth-handler.js';
import { SessionStore } from '../src/runtime/session-store.js';
import { detectLoginWall, extractAuthArtifacts, buildAuthStatePlan, deriveAuthStatePlanFromResults } from '../src/runtime/auth-state.js';
import { OmniCrawler } from '../src/api/omnicrawler.js';

test('auth handlers support basic, bearer, api-key, and cookie request application', async () => {
  const basic = createAuthHandler({ type: 'basic', username: 'demo', password: 'secret' });
  const bearer = createAuthHandler({ type: 'bearer', token: 'abc' });
  const apiKey = createAuthHandler({ type: 'api-key', key: 'api_key', value: 'k1', in: 'query' });
  const cookie = createAuthHandler({ type: 'cookie', cookies: { sid: 'session-1', theme: 'dark' } });

  assert.match((await basic.getAuthHeaders()).Authorization, /^Basic /);
  assert.equal((await bearer.getAuthHeaders()).Authorization, 'Bearer abc');

  const apiApplied = await apiKey.applyToRequest({ url: 'https://example.com/items?x=1', headers: {} });
  assert.match(apiApplied.url, /api_key=k1/);

  const cookieApplied = await cookie.applyToRequest({ url: 'https://example.com', headers: {} });
  assert.equal(cookieApplied.headers.Cookie, 'sid=session-1; theme=dark');
});

test('SessionStore merges auth state and builds replay-aware request headers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-auth-session-'));
  try {
    const store = new SessionStore({ projectRoot: root });
    await store.init();
    await store.save({
      id: 'auth-session',
      cookies: [{ name: 'sid', value: 'abc', domain: 'example.com', path: '/' }],
      localStorage: { 'https://example.com': { token: 'legacy' } },
      sessionStorage: {},
      updatedAt: new Date().toISOString(),
    });

    await store.mergeAuthState('auth-session', {
      headers: { authorization: 'Bearer demo-token' },
      cookies: { refresh: 'r1' },
      tokens: { accessToken: 'demo-token' },
      replayState: { csrfToken: 'csrf-1' },
    });

    const state = await store.buildRequestState('auth-session', 'https://example.com/profile');
    assert.match(state.headers.cookie, /sid=abc/);
    assert.match(state.headers.cookie, /refresh=r1/);
    assert.equal(state.headers.authorization, 'Bearer demo-token');
    assert.equal(state.replayState.accessToken, 'demo-token');
    assert.equal(state.replayState.csrfToken, 'csrf-1');
    assert.equal(state.snapshot.auth.tokens.accessToken, 'demo-token');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('auth-state helpers detect login walls and extract tokens/cookies', () => {
  const payload = {
    status: 401,
    headers: {
      'set-cookie': ['session=abc; Path=/', 'refresh=def; Path=/'],
      authorization: 'Bearer upstream-token',
      location: '/login',
    },
    body: JSON.stringify({
      access_token: 'token-1',
      refresh_token: 'token-2',
    }),
    html: `
      <html>
        <body>
          <form action="/login">
            <input type="password" />
            <input type="hidden" name="csrfToken" value="csrf-123" />
          </form>
        </body>
      </html>
    `,
    extracted: {
      sessionToken: 'session-inline',
    },
  };

  const loginWall = detectLoginWall(payload);
  const artifacts = extractAuthArtifacts(payload);
  const plan = buildAuthStatePlan(payload);

  assert.equal(loginWall.detected, true);
  assert.ok(artifacts.cookieNames.includes('session'));
  assert.equal(artifacts.hiddenFields.csrfToken, 'csrf-123');
  assert.equal(artifacts.tokenFields.access_token, 'token-1');
  assert.equal(artifacts.tokenFields.sessionToken, 'session-inline');
  assert.equal(plan.sessionLikelyRequired, true);
  assert.equal(plan.requiredHeaders.authorization, 'Bearer upstream-token');
  assert.equal(plan.replayState.csrfToken, 'csrf-123');
});

test('OmniCrawler applies auth handlers that mutate request URLs', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-auth-crawler-'));
  const baseUrl = `http://127.0.0.1:${server.address().port}/items`;

  try {
    const crawler = new OmniCrawler({ name: 'auth-query', projectRoot: root })
      .addSeedUrls(baseUrl)
      .setMode('http')
      .useAuth({
        type: 'api-key',
        key: 'api_key',
        value: 'demo',
        in: 'query',
      });

    const summary = await crawler.run();
    assert.equal(summary.status, 'completed');
    assert.equal(requests.length, 1);
    assert.match(requests[0], /api_key=demo/);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('deriveAuthStatePlanFromResults aggregates replay state and auth-wall signals', () => {
  const plan = deriveAuthStatePlanFromResults([
    {
      url: 'https://example.com/bootstrap',
      finalUrl: 'https://example.com/login',
      status: 200,
      replayState: {
        csrfToken: 'csrf-1',
        access_token: 'token-1',
      },
      extracted: {
        refresh_token: 'refresh-1',
      },
      diagnostics: {
        authWallLikely: true,
      },
    },
    {
      url: 'https://example.com/profile',
      finalUrl: 'https://example.com/profile',
      status: 200,
      replayState: {
        sessionCookie: 'abc',
      },
      extracted: {},
      diagnostics: {},
    },
  ]);

  assert.equal(plan.loginWallDetected, true);
  assert.ok(plan.loginWallReasons.includes('result-auth-wall'));
  assert.equal(plan.replayState.csrfToken, 'csrf-1');
  assert.equal(plan.replayState.access_token, 'token-1');
  assert.equal(plan.replayState.sessionCookie, 'abc');
  assert.equal(plan.refreshLikely, true);
});
