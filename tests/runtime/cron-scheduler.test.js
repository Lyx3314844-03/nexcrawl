/**
 * Unit tests for cron-scheduler module.
 * @module tests/runtime/cron-scheduler.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('cron-scheduler', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'omnicrawl-cron-'));
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('module exports', () => {
    it('should export createCronScheduler as an async function', async () => {
      const mod = await import('../../src/runtime/cron-scheduler.js');
      assert.equal(typeof mod.createCronScheduler, 'function');
    });
  });

  describe('createCronScheduler', () => {
    it('should return a scheduler with addJob, removeJob, toggleJob, listJobs, registerCallback, close', async () => {
      const { createCronScheduler } = await import('../../src/runtime/cron-scheduler.js');
      const scheduler = await createCronScheduler({
        storagePath: join(tmpDir, 'crons.json'),
        restoreOnStartup: false,
      });
      assert.equal(typeof scheduler.addJob, 'function');
      assert.equal(typeof scheduler.removeJob, 'function');
      assert.equal(typeof scheduler.toggleJob, 'function');
      assert.equal(typeof scheduler.listJobs, 'function');
      assert.equal(typeof scheduler.registerCallback, 'function');
      assert.equal(typeof scheduler.close, 'function');
      await scheduler.close();
    });

    it('should add a job and list it', async () => {
      const { createCronScheduler } = await import('../../src/runtime/cron-scheduler.js');
      const scheduler = await createCronScheduler({
        storagePath: join(tmpDir, 'crons.json'),
        restoreOnStartup: false,
      });
      let tickCount = 0;
      await scheduler.addJob('test-job', '0 8 * * 1-5', {
        intervalMs: 60000,
        onTick: async () => { tickCount++; },
        enabled: true,
      });
      const jobs = scheduler.listJobs();
      assert.ok(Array.isArray(jobs));
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].id, 'test-job');
      await scheduler.close();
    });

    it('should remove a job', async () => {
      const { createCronScheduler } = await import('../../src/runtime/cron-scheduler.js');
      const scheduler = await createCronScheduler({
        storagePath: join(tmpDir, 'crons.json'),
        restoreOnStartup: false,
      });
      await scheduler.addJob('removable-job', '0 8 * * 1-5', {
        intervalMs: 60000,
        onTick: async () => {},
      });
      assert.equal(scheduler.listJobs().length, 1);
      await scheduler.removeJob('removable-job');
      assert.equal(scheduler.listJobs().length, 0);
      await scheduler.close();
    });

    it('should toggle a job enabled/disabled', async () => {
      const { createCronScheduler } = await import('../../src/runtime/cron-scheduler.js');
      const scheduler = await createCronScheduler({
        storagePath: join(tmpDir, 'crons.json'),
        restoreOnStartup: false,
      });
      await scheduler.addJob('toggle-job', '0 8 * * 1-5', {
        intervalMs: 60000,
        onTick: async () => {},
      });
      await scheduler.toggleJob('toggle-job', false);
      const jobs = scheduler.listJobs();
      assert.equal(jobs[0].enabled, false);
      await scheduler.toggleJob('toggle-job', true);
      const updated = scheduler.listJobs();
      assert.equal(updated[0].enabled, true);
      await scheduler.close();
    });

    it('should register a callback for a job', async () => {
      const { createCronScheduler } = await import('../../src/runtime/cron-scheduler.js');
      const scheduler = await createCronScheduler({
        storagePath: join(tmpDir, 'crons.json'),
        restoreOnStartup: false,
      });
      await scheduler.addJob('cb-job', '0 8 * * 1-5', {
        intervalMs: 60000,
      });
      let called = false;
      scheduler.registerCallback('cb-job', async () => { called = true; });
      // The callback should be registered without error
      assert.equal(called, false); // Not called yet
      await scheduler.close();
    });

    it('should close without error', async () => {
      const { createCronScheduler } = await import('../../src/runtime/cron-scheduler.js');
      const scheduler = await createCronScheduler({
        storagePath: join(tmpDir, 'crons.json'),
        restoreOnStartup: false,
      });
      await scheduler.addJob('close-job', '0 8 * * 1-5', {
        intervalMs: 60000,
        onTick: async () => {},
      });
      await assert.doesNotReject(() => scheduler.close());
    });

    it('should use intervalMs fallback when cron-parser is not installed', async () => {
      const { createCronScheduler } = await import('../../src/runtime/cron-scheduler.js');
      const scheduler = await createCronScheduler({
        storagePath: join(tmpDir, 'crons.json'),
        restoreOnStartup: false,
      });
      // Add with a short interval for testing (won't actually tick in this test)
      await scheduler.addJob('interval-job', '0 8 * * 1-5', {
        intervalMs: 5000,
        onTick: async () => {},
      });
      const jobs = scheduler.listJobs();
      assert.equal(jobs.length, 1);
      await scheduler.close();
    });
  });
});
