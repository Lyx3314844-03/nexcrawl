import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPool } from '../src/runtime/session-pool.js';

test('session pool persists sessions, binds proxies, and retires unhealthy sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-session-pool-'));

  try {
    const pool = new SessionPool({
      projectRoot: root,
      poolId: 'session-pool-test',
      config: {
        enabled: true,
        maxSessions: 2,
        maxFailures: 2,
        retireAfterUses: 100,
        bindProxy: true,
        strategy: 'leastUsed',
      },
    });
    await pool.init();

    const first = await pool.acquire();
    assert.ok(first.id);

    await pool.bindProxy(first.id, {
      server: 'http://127.0.0.1:9000',
      label: 'proxy-a',
    });
    await pool.bindIdentityProfile(first.id, {
      userAgent: 'Mozilla/5.0 SessionPool Test',
      acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
      tlsProfile: 'chrome-latest',
      fingerprintKey: first.id,
    });
    await pool.reportFailure(first.id, { message: 'blocked-1' });
    await pool.reportFailure(first.id, { message: 'blocked-2' });

    const second = await pool.acquire();
    assert.notEqual(second.id, first.id);

    const reloaded = new SessionPool({
      projectRoot: root,
      poolId: 'session-pool-test',
      config: {
        enabled: true,
        maxSessions: 2,
        maxFailures: 2,
      },
    });
    await reloaded.init();

    const items = await reloaded.list();
    const retired = items.find((item) => item.id === first.id);
    assert.ok(retired);
    assert.equal(retired.status, 'retired');
    assert.equal(retired.boundProxy.server, 'http://127.0.0.1:9000');
    assert.equal(retired.boundIdentityProfile.userAgent, 'Mozilla/5.0 SessionPool Test');
    assert.equal(retired.boundIdentityProfile.tlsProfile, 'chrome-latest');

    const active = items.find((item) => item.id === second.id);
    assert.ok(active);
    assert.equal(active.status, 'active');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
