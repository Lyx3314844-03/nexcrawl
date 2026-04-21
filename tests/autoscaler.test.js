import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoscaleController } from '../src/runtime/autoscaler.js';

test('autoscaler increases and decreases concurrency from runtime samples', () => {
  const autoscaler = new AutoscaleController({
    config: {
      enabled: true,
      minConcurrency: 1,
      maxConcurrency: 4,
      targetLatencyMs: 1000,
      maxFailureRate: 0.25,
      sampleWindow: 6,
    },
    maxConcurrency: 4,
  });

  assert.equal(autoscaler.limit(), 1);

  autoscaler.report({ durationMs: 200, ok: true });
  autoscaler.report({ durationMs: 250, ok: true });
  autoscaler.report({ durationMs: 300, ok: true });
  assert.ok(autoscaler.limit() > 1);

  autoscaler.report({ durationMs: 4000, ok: false });
  autoscaler.report({ durationMs: 4500, ok: false });
  autoscaler.report({ durationMs: 4200, ok: false });
  assert.ok(autoscaler.limit() < 4);
});
