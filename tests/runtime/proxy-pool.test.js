import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProxyPool } from '../../src/runtime/proxy-pool.js';

describe('ProxyPool', () => {
  let tmpDir;
  let pool;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-proxy-'));
    pool = new ProxyPool({ projectRoot: tmpDir });
    await pool.init();
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('initializes with empty state', () => {
    const list = pool.list();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 0);
  });

  it('preparePool normalizes and registers proxies', () => {
    const config = {
      strategy: 'roundRobin',
      proxies: [
        { server: 'http://proxy1:8080', username: 'user1', password: 'pass1' },
        { server: 'http://proxy2:8080' }
      ]
    };
    pool.preparePool(config);
    const list = pool.list();
    assert.equal(list.length, 2);
    assert.ok(list[0].key);
    assert.equal(list[0].health, 100);
  });

  it('selectProxy returns null when pool is empty', () => {
    const result = pool.selectProxy({ proxyPool: { proxies: [] } });
    assert.equal(result, null);
  });

  it('selectProxy uses roundRobin strategy', () => {
    const proxyPool = {
      strategy: 'roundRobin',
      proxies: [{ server: 'http://p1:8080' }, { server: 'http://p2:8080' }]
    };
    pool.preparePool(proxyPool);
    const first = pool.selectProxy({ proxyPool });
    const second = pool.selectProxy({ proxyPool });
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.key, second.key);
  });

  it('selectProxy uses healthiest strategy', () => {
    const proxyPool = {
      strategy: 'healthiest',
      proxies: [{ server: 'http://p1:8080' }, { server: 'http://p2:8080' }]
    };
    pool.preparePool(proxyPool);
    pool.reportSuccess({ server: 'http://p1:8080' });
    pool.reportFailure({ server: 'http://p2:8080' }, { message: 'timeout' });
    const selected = pool.selectProxy({ proxyPool });
    assert.ok(selected);
    assert.equal(selected.server, 'http://p1:8080');
  });

  it('reportSuccess increases health score', () => {
    const proxyPool = { strategy: 'roundRobin', proxies: [{ server: 'http://p1:8080' }] };
    pool.preparePool(proxyPool);
    const before = pool.list()[0].health;
    pool.reportSuccess({ server: 'http://p1:8080' });
    const after = pool.list()[0].health;
    assert.ok(after >= before);
  });

  it('reportFailure decreases health score', () => {
    const proxyPool = {
      strategy: 'roundRobin',
      proxies: [{ server: 'http://p1:8080' }],
      cooldownAfterFailures: 3,
      cooldownDurationMs: 60000
    };
    pool.preparePool(proxyPool);
    pool.reportFailure({ server: 'http://p1:8080' }, { message: 'timeout', proxyPool });
    const entry = pool.list()[0];
    assert.ok(entry.health < 100);
  });

  it('repeated failures trigger cooldown', () => {
    const proxyPool = {
      strategy: 'roundRobin',
      proxies: [{ server: 'http://p1:8080' }],
      cooldownAfterFailures: 2,
      cooldownDurationMs: 60000
    };
    pool.preparePool(proxyPool);
    pool.reportFailure({ server: 'http://p1:8080' }, { message: 'err', proxyPool });
    pool.reportFailure({ server: 'http://p1:8080' }, { message: 'err', proxyPool });
    const entry = pool.list()[0];
    assert.ok(entry.cooldownUntil > Date.now());
    assert.ok(entry.inCooldown);
  });

  it('setEnabled toggles proxy availability', () => {
    const proxyPool = { strategy: 'roundRobin', proxies: [{ server: 'http://p1:8080' }] };
    pool.preparePool(proxyPool);
    const key = pool.list()[0].key;
    pool.setEnabled(key, false);
    const entry = pool.list().find(e => e.key === key);
    assert.equal(entry.enabled, false);
    pool.setEnabled(key, true);
    const updated = pool.list().find(e => e.key === key);
    assert.equal(updated.enabled, true);
  });

  it('reset restores proxy to defaults', () => {
    const proxyPool = { strategy: 'roundRobin', proxies: [{ server: 'http://p1:8080' }] };
    pool.preparePool(proxyPool);
    pool.reportFailure({ server: 'http://p1:8080' }, { message: 'err', proxyPool });
    const key = pool.list()[0].key;
    pool.reset(key);
    const entry = pool.list().find(e => e.key === key);
    assert.equal(entry.health, 100);
    assert.equal(entry.consecutiveFailures, 0);
  });

  it('updateNotes changes proxy notes', () => {
    const proxyPool = { strategy: 'roundRobin', proxies: [{ server: 'http://p1:8080' }] };
    pool.preparePool(proxyPool);
    const key = pool.list()[0].key;
    pool.updateNotes(key, 'residential proxy');
    const entry = pool.list().find(e => e.key === key);
    assert.equal(entry.notes, 'residential proxy');
  });

  it('persist and reload preserves state', async () => {
    const proxyPool = { strategy: 'roundRobin', proxies: [{ server: 'http://p1:8080' }] };
    pool.preparePool(proxyPool);
    pool.reportSuccess({ server: 'http://p1:8080' });
    await pool.persist();

    const pool2 = new ProxyPool({ projectRoot: tmpDir });
    await pool2.init();
    const list = pool2.list();
    assert.equal(list.length, 1);
    assert.ok(list[0].successes > 0);
  });

  it('stickySession assigns same proxy for same affinityKey', () => {
    const proxyPool = {
      strategy: 'roundRobin',
      stickySession: true,
      proxies: [
        { server: 'http://p1:8080' },
        { server: 'http://p2:8080' },
        { server: 'http://p3:8080' }
      ]
    };
    pool.preparePool(proxyPool);
    const a = pool.selectProxy({ proxyPool, affinityKey: 'session-1' });
    const b = pool.selectProxy({ proxyPool, affinityKey: 'session-1' });
    assert.equal(a.key, b.key);
  });
});
