import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatasetStore } from '../../src/runtime/dataset-store.js';

describe('DatasetStore', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-ds-'));
    store = new DatasetStore({ projectRoot: tmpDir, datasetId: 'test-dataset' });
    await store.init();
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('initializes with default manifest', async () => {
    const info = store.getInfo();
    assert.ok(info);
    assert.equal(info.id, 'test-dataset');
    assert.equal(info.itemCount, 0);
  });

  it('addItem appends items and updates count', async () => {
    await store.addItem({ title: 'Item 1', url: 'https://example.com/1' });
    await store.addItem({ title: 'Item 2', url: 'https://example.com/2' });
    const info = store.getInfo();
    assert.equal(info.itemCount, 2);
  });

  it('listItems returns paginated items', async () => {
    for (let i = 0; i < 5; i++) {
      await store.addItem({ title: `Item ${i}` });
    }
    const page1 = await store.listItems({ offset: 0, limit: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page1.items.length, 2);
    const page2 = await store.listItems({ offset: 2, limit: 2 });
    assert.equal(page2.total, 5);
    assert.equal(page2.items.length, 2);
  });

  it('listItems with query filters by text', async () => {
    await store.addItem({ title: 'Python tutorial' });
    await store.addItem({ title: 'JavaScript guide' });
    await store.addItem({ title: 'Python advanced' });
    const results = await store.listItems({ query: 'Python' });
    assert.equal(results.total, 2);
    assert.equal(results.items.length, 2);
  });

  it('setMetadata merges metadata', async () => {
    await store.setMetadata({ source: 'test-crawl' });
    const info = store.getInfo();
    assert.equal(info.metadata.source, 'test-crawl');
  });

  it('static list returns all datasets', async () => {
    await store.addItem({ test: true });
    const list = await DatasetStore.list({ projectRoot: tmpDir });
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
  });

  it('static get retrieves dataset info', async () => {
    await store.addItem({ test: true });
    const info = await DatasetStore.get({ projectRoot: tmpDir, datasetId: 'test-dataset' });
    assert.ok(info);
    assert.equal(info.id, 'test-dataset');
  });
});
