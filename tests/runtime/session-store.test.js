import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/runtime/session-store.js';

describe('SessionStore', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-session-'));
    store = new SessionStore({ projectRoot: tmpDir });
    await store.init();
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('initializes and creates storage directory', async () => {
    const store2 = new SessionStore({ projectRoot: tmpDir });
    await store2.init();
    assert.ok(store2);
  });

  it('save and load round-trips a snapshot', async () => {
    const snapshot = {
      id: 'test-session',
      cookies: [{ name: 'sid', value: 'abc123', domain: 'example.com', path: '/' }],
      localStorage: { 'example.com': { key: 'val' } },
      sessionStorage: {},
      updatedAt: new Date().toISOString()
    };
    await store.save(snapshot);
    const loaded = await store.load('test-session');
    assert.equal(loaded.id, 'test-session');
    assert.equal(loaded.cookies.length, 1);
    assert.equal(loaded.cookies[0].name, 'sid');
  });

  it('load returns empty snapshot for non-existent session', async () => {
    const loaded = await store.load('non-existent');
    assert.ok(loaded);
    assert.ok(loaded.cookies);
    assert.equal(loaded.cookies.length, 0);
  });

  it('list returns session summaries', async () => {
    await store.save({ id: 's1', cookies: [], localStorage: {}, sessionStorage: {}, updatedAt: new Date().toISOString() });
    await store.save({ id: 's2', cookies: [], localStorage: {}, sessionStorage: {}, updatedAt: new Date().toISOString() });
    const list = await store.list();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 2);
  });

  it('list respects limit parameter', async () => {
    for (let i = 0; i < 5; i++) {
      await store.save({ id: `s${i}`, cookies: [], localStorage: {}, sessionStorage: {}, updatedAt: new Date().toISOString() });
    }
    const list = await store.list(2);
    assert.equal(list.length, 2);
  });

  it('buildCookieHeader constructs cookie string for matching URL', async () => {
    const snapshot = {
      id: 'cookie-test',
      cookies: [
        { name: 'sid', value: 'abc', domain: 'example.com', path: '/' },
        { name: 'other', value: 'xyz', domain: 'other.com', path: '/' }
      ],
      localStorage: {},
      sessionStorage: {},
      updatedAt: new Date().toISOString()
    };
    const header = store.buildCookieHeader(snapshot, 'https://example.com/page');
    assert.ok(header.includes('sid=abc'));
    assert.ok(!header.includes('other='));
  });

  it('mergeHttpResponse adds Set-Cookie entries', async () => {
    await store.save({ id: 'merge-test', cookies: [], localStorage: {}, sessionStorage: {}, updatedAt: new Date().toISOString() });
    await store.mergeHttpResponse('merge-test', 'https://example.com', [
      'session=def456; Domain=example.com; Path=/'
    ]);
    const loaded = await store.load('merge-test');
    assert.equal(loaded.cookies.length, 1);
    assert.equal(loaded.cookies[0].name, 'session');
  });
});
