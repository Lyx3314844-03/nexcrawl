import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkflowRepairPlan } from '../src/runtime/workflow-repair.js';

test('workflow repair plan upgrades workflow from diagnostics and replay recipe', () => {
  const plan = buildWorkflowRepairPlan({
    workflow: {
      name: 'repair-demo',
      seedUrls: ['https://example.com'],
      mode: 'http',
      concurrency: 1,
      maxDepth: 0,
      extract: [],
      plugins: [{ name: 'dedupe' }],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    },
    recipe: {
      recommendedMode: 'browser',
    },
    diagnostics: {
      suspects: [
        { type: 'auth-or-session-state' },
        { type: 'signature-or-parameter-chain' },
        { type: 'identity-drift' },
      ],
    },
    failedRequests: [{ url: 'https://example.com/login', error: '403' }],
  });

  assert.equal(plan.rebuiltWorkflow.mode, 'browser');
  assert.equal(plan.rebuiltWorkflow.session.enabled, true);
  assert.equal(plan.rebuiltWorkflow.reverse.autoReverseAnalysis, true);
  assert.equal(plan.rebuiltWorkflow.signer.enabled, true);
  assert.equal(plan.rebuiltWorkflow.identity.enabled, true);
  assert.equal(plan.rebuiltWorkflow.output.persistBodies, true);
  assert.ok(plan.reasons.length >= 3);
});
