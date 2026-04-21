import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KeyValueStore } from '../../src/runtime/key-value-store.js';

describe('KeyValueStore', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-kv-'));
    store = new KeyValueStore({ projectRoot: tmpDir, storeId: 'test-store' });
    await store.init();
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('initializes with default manifest', async () => {
    const info = store.getInfo();
    assert.ok(info);
    assert.equal(info.id, 'test-store');
  });

  it('setRecord and getRecord round-trip data', async () => {
    await store.setRecord('key1', { hello: 'world' });
    const record = await store.getRecord('key1');
    assert.deepEqual(record.value, { hello: 'world' });
  });

  it('setRecord overwrites existing key', async () => {
    await store.setRecord('key1', 'v1');
    await store.setRecord('key1', 'v2');
    const record = await store.getRecord('key1');
    assert.equal(record.value, 'v2');
  });

  it('getRecord returns undefined for missing key', async () => {
    const record = await store.getRecord('nonexistent');
    assert.equal(record, undefined);
  });

  it('listRecords returns all records', async () => {
    await store.setRecord('a', 1);
    await store.setRecord('b', 2);
    const records = store.listRecords();
    assert.ok(Array.isArray(records));
    assert.equal(records.length, 2);
  });

  it('setMetadata merges metadata', async () => {
    await store.setMetadata({ description: 'test store' });
    await store.setMetadata({ version: '1.0' });
    const info = store.getInfo();
    assert.equal(info.metadata.description, 'test store');
    assert.equal(info.metadata.version, '1.0');
  });

  it('static list returns store summaries', async () => {
    await store.setRecord('k', 'v');
    const list = await KeyValueStore.list({ projectRoot: tmpDir });
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
  });

  it('static get retrieves store info', async () => {
    await store.setRecord('k', 'v');
    const info = await KeyValueStore.get({ projectRoot: tmpDir, storeId: 'test-store' });
    assert.ok(info);
    assert.equal(info.id, 'test-store');
  });
});
