/**
 * Tests for GracefulShutdown — Phase 1.6
 *
 * Covers:
 *   - Signal handler installation
 *   - Cleanup callback execution order
 *   - Job persistence runs BEFORE cleanup
 *   - Timeout force exit
 *   - Double-signal protection
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { GracefulShutdown } from '../src/api/graceful-shutdown.js';

describe('GracefulShutdown — Callback Execution', () => {
  it('should run persistence callbacks before cleanup callbacks', async () => {
    const order = [];
    const shutdown = new GracefulShutdown({ install: false, timeoutMs: 5000 });

    shutdown.register(() => { order.push('cleanup-1'); return Promise.resolve(); });
    shutdown.registerJobPersistence(() => { order.push('persist-1'); return Promise.resolve(); });
    shutdown.register(() => { order.push('cleanup-2'); return Promise.resolve(); });
    shutdown.registerJobPersistence(() => { order.push('persist-2'); return Promise.resolve(); });

    await shutdown._performShutdown();

    assert.deepEqual(order, ['persist-1', 'persist-2', 'cleanup-1', 'cleanup-2'],
      'Persistence should run before cleanup');
  });

  it('should support multiple persistence callbacks', async () => {
    let count = 0;
    const shutdown = new GracefulShutdown({ install: false, timeoutMs: 5000 });

    shutdown.registerJobPersistence(() => { count++; return Promise.resolve(); });
    shutdown.registerJobPersistence(() => { count++; return Promise.resolve(); });
    shutdown.register(() => { return Promise.resolve(); });

    await shutdown._performShutdown();
    assert.equal(count, 2, 'Both persistence callbacks should run');
  });

  it('should continue cleanup even if persistence fails', async () => {
    let cleanupRan = false;
    const shutdown = new GracefulShutdown({ install: false, timeoutMs: 5000 });

    shutdown.registerJobPersistence(() => { throw new Error('persist failed'); });
    shutdown.register(() => { cleanupRan = true; return Promise.resolve(); });

    await shutdown._performShutdown();
    assert.ok(cleanupRan, 'Cleanup should run even after persistence failure');
  });

  it('should not run callbacks twice on double shutdown', async () => {
    let count = 0;
    const shutdown = new GracefulShutdown({ install: false, timeoutMs: 5000 });

    shutdown.register(() => { count++; return Promise.resolve(); });

    await shutdown._performShutdown();
    await shutdown._performShutdown();

    assert.equal(count, 1, 'Callbacks should only run once');
  });
});

describe('GracefulShutdown — Configuration', () => {
  it('should accept custom timeout', () => {
    const shutdown = new GracefulShutdown({ install: false, timeoutMs: 30000 });
    assert.equal(shutdown._timeoutMs, 30000);
  });

  it('should default to 15000ms timeout', () => {
    const shutdown = new GracefulShutdown({ install: false });
    assert.equal(shutdown._timeoutMs, 15000);
  });

  it('should not install handlers when install=false', () => {
    const shutdown = new GracefulShutdown({ install: false });
    assert.ok(!shutdown._installed, 'Should not auto-install');
  });

  it('should share process signal handlers across multiple installed instances', () => {
    const baseSigint = process.listenerCount('SIGINT');
    const baseSigterm = process.listenerCount('SIGTERM');
    const baseSighup = process.listenerCount('SIGHUP');

    const first = new GracefulShutdown({ install: true });
    const second = new GracefulShutdown({ install: true });

    try {
      assert.equal(process.listenerCount('SIGINT'), baseSigint + 1);
      assert.equal(process.listenerCount('SIGTERM'), baseSigterm + 1);
      assert.equal(process.listenerCount('SIGHUP'), baseSighup + 1);
    } finally {
      first.uninstall();
      second.uninstall();
    }

    assert.equal(process.listenerCount('SIGINT'), baseSigint);
    assert.equal(process.listenerCount('SIGTERM'), baseSigterm);
    assert.equal(process.listenerCount('SIGHUP'), baseSighup);
  });

  it('should register onShutdown callback via options', () => {
    let called = false;
    const shutdown = new GracefulShutdown({
      install: false,
      onShutdown: () => { called = true; return Promise.resolve(); },
    });

    return shutdown._performShutdown().then(() => {
      assert.ok(called, 'onShutdown callback should be called');
    });
  });
});

describe('GracefulShutdown — register() chaining', () => {
  it('should return this for method chaining', () => {
    const shutdown = new GracefulShutdown({ install: false });
    const result = shutdown.register(() => Promise.resolve());
    assert.equal(result, shutdown, 'register() should return this');
  });

  it('should return this for registerJobPersistence chaining', () => {
    const shutdown = new GracefulShutdown({ install: false });
    const result = shutdown.registerJobPersistence(() => Promise.resolve());
    assert.equal(result, shutdown, 'registerJobPersistence() should return this');
  });
});
