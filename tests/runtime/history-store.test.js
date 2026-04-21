import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from '../../src/runtime/history-store.js';

describe('HistoryStore', () => {
  let tmpDir;
  let store;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-hist-'));
    store = new HistoryStore({ projectRoot: tmpDir });
    await store.init();
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('initializes with empty records', () => {
    const list = store.list();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 0);
  });

  it('append adds a record', async () => {
    await store.append({ jobId: 'job-1', workflowName: 'test', status: 'finished', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].jobId, 'job-1');
  });

  it('append replaces existing record with same jobId', async () => {
    await store.append({ jobId: 'job-1', workflowName: 'test', status: 'running', startedAt: new Date().toISOString() });
    await store.append({ jobId: 'job-1', workflowName: 'test', status: 'finished', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, 'finished');
  });

  it('get retrieves a specific record by jobId', async () => {
    await store.append({ jobId: 'job-1', workflowName: 'test', status: 'finished', startedAt: new Date().toISOString() });
    const record = store.get('job-1');
    assert.ok(record);
    assert.equal(record.jobId, 'job-1');
  });

  it('list returns records sorted by timestamp desc', async () => {
    await store.append({ jobId: 'job-1', workflowName: 'a', status: 'finished', startedAt: '2025-01-01T00:00:00Z', finishedAt: '2025-01-01T01:00:00Z' });
    await store.append({ jobId: 'job-2', workflowName: 'b', status: 'finished', startedAt: '2025-01-02T00:00:00Z', finishedAt: '2025-01-02T01:00:00Z' });
    const list = store.list();
    assert.equal(list[0].jobId, 'job-2');
  });

  it('findPreviousCompleted returns latest completed for workflow', async () => {
    await store.append({ jobId: 'j1', workflowName: 'wf', status: 'finished', startedAt: '2025-01-01T00:00:00Z', finishedAt: '2025-01-01T01:00:00Z' });
    await store.append({ jobId: 'j2', workflowName: 'wf', status: 'finished', startedAt: '2025-01-02T00:00:00Z', finishedAt: '2025-01-02T01:00:00Z' });
    const prev = store.findPreviousCompleted('wf');
    assert.ok(prev);
    assert.equal(prev.jobId, 'j2');
  });

  it('findPreviousCompleted excludes specified jobId', async () => {
    await store.append({ jobId: 'j1', workflowName: 'wf', status: 'finished', startedAt: '2025-01-01T00:00:00Z', finishedAt: '2025-01-01T01:00:00Z' });
    await store.append({ jobId: 'j2', workflowName: 'wf', status: 'finished', startedAt: '2025-01-02T00:00:00Z', finishedAt: '2025-01-02T01:00:00Z' });
    const prev = store.findPreviousCompleted('wf', { excludeJobId: 'j2' });
    assert.ok(prev);
    assert.equal(prev.jobId, 'j1');
  });

  it('persists records across restarts', async () => {
    await store.append({ jobId: 'job-1', workflowName: 'test', status: 'finished', startedAt: new Date().toISOString() });
    const store2 = new HistoryStore({ projectRoot: tmpDir });
    await store2.init();
    const list = store2.list();
    assert.equal(list.length, 1);
  });
});
