import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleManager } from '../../src/runtime/scheduler.js';

describe('ScheduleManager', () => {
  let tmpDir;
  let scheduler;
  let launchedWorkflows;

  function createScheduler(opts = {}) {
    return new ScheduleManager({
      projectRoot: tmpDir,
      workflowRegistry: {
        get: async () => ({ id: 'test-wf', name: 'test', mode: 'http', seedRequests: [] })
      },
      jobStore: { create: async () => ({ jobId: 'j1' }) },
      historyStore: { append: async () => {} },
      launchWorkflow: async () => { launchedWorkflows.push(Date.now()); return { jobId: 'j1' }; },
      restoreTimers: false,
      ...opts
    });
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-sched-'));
    launchedWorkflows = [];
    scheduler = createScheduler();
    await scheduler.init();
  });

  afterEach(async () => {
    await scheduler.close();
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('initializes with no schedules', () => {
    const list = scheduler.list();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 0);
  });

  it('create adds a new schedule', async () => {
    const schedule = await scheduler.create({ workflowId: 'test-wf', intervalMs: 60000, enabled: false });
    assert.ok(schedule.id);
    assert.equal(schedule.workflowId, 'test-wf');
    assert.equal(schedule.intervalMs, 60000);
    assert.equal(schedule.enabled, false);
    const list = scheduler.list();
    assert.equal(list.length, 1);
  });

  it('get retrieves a schedule by id', async () => {
    const created = await scheduler.create({ workflowId: 'test-wf', intervalMs: 60000 });
    const found = scheduler.get(created.id);
    assert.ok(found);
    assert.equal(found.id, created.id);
  });

  it('setEnabled toggles schedule', async () => {
    const created = await scheduler.create({ workflowId: 'test-wf', intervalMs: 60000, enabled: false });
    await scheduler.setEnabled(created.id, true);
    const found = scheduler.get(created.id);
    assert.equal(found.enabled, true);
  });

  it('tick executes the associated workflow', async () => {
    const created = await scheduler.create({ workflowId: 'test-wf', intervalMs: 60000, enabled: false });
    await scheduler.tick(created.id);
    assert.equal(launchedWorkflows.length, 1);
    const found = scheduler.get(created.id);
    assert.ok(found.lastRunAt);
    assert.equal(found.lastJobId, 'j1');
  });

  it('close clears all timers', async () => {
    await scheduler.create({ workflowId: 'test-wf', intervalMs: 60000, enabled: true });
    await scheduler.close();
    // No error means success
  });

  it('persists schedules across restarts', async () => {
    await scheduler.create({ workflowId: 'test-wf', intervalMs: 60000, enabled: false });
    const scheduler2 = createScheduler();
    await scheduler2.init();
    const list = scheduler2.list();
    assert.equal(list.length, 1);
    await scheduler2.close();
  });
});
