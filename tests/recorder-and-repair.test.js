import { test } from 'node:test';
import assert from 'node:assert';
import { buildWorkflowRepairPlan, registerAndRerunRepair } from '../src/runtime/workflow-repair.js';

test('buildWorkflowRepairPlan - adds quickActions', () => {
  const workflow = {
    name: 'test-workflow',
    mode: 'http',
    plugins: [],
    seedUrls: ['https://example.com'],
  };

  const plan = buildWorkflowRepairPlan({ workflow });

  assert.ok(plan.quickActions);
  assert.strictEqual(plan.quickActions.registerAndRerun.enabled, true);
  assert.strictEqual(plan.quickActions.registerAndRerun.workflowId, 'test-workflow-repaired');
  assert.strictEqual(plan.quickActions.registerAndRerun.endpoint, '/api/workflows/register-and-run');
});

test('buildWorkflowRepairPlan - handles auth suspect', () => {
  const workflow = {
    name: 'test',
    mode: 'browser',
    seedUrls: ['https://example.com'],
  };

  const diagnostics = {
    suspects: [{ type: 'auth-or-session-state' }],
  };

  const plan = buildWorkflowRepairPlan({ workflow, diagnostics });

  assert.ok(plan.patch.session);
  assert.strictEqual(plan.patch.session.enabled, true);
  assert.ok(plan.reasons.some(r => r.includes('session')));
});

test('registerAndRerunRepair - requires repairPlan', async () => {
  await assert.rejects(
    async () => registerAndRerunRepair({}),
    /repairPlan.rebuiltWorkflow is required/
  );
});

test('registerAndRerunRepair - registers and runs workflow', async () => {
  const mockWorkflowRegistry = {
    register: async (data) => {
      assert.strictEqual(data.id, 'test-repaired');
      assert.ok(data.workflow);
      assert.strictEqual(data.metadata.source, 'auto-repair');
    },
  };

  const mockJobStore = {
    create: async (data) => {
      assert.strictEqual(data.workflowId, 'test-repaired');
      return { id: 'job-123', ...data };
    },
  };

  const mockJobRunner = {
    run: async (jobId) => {
      assert.strictEqual(jobId, 'job-123');
      return { success: true };
    },
  };

  const repairPlan = {
    rebuiltWorkflow: { name: 'test' },
    suggestedWorkflowId: 'test-repaired',
    reasons: ['test reason'],
  };

  const result = await registerAndRerunRepair({
    repairPlan,
    jobStore: mockJobStore,
    workflowRegistry: mockWorkflowRegistry,
    jobRunner: mockJobRunner,
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.workflowId, 'test-repaired');
  assert.strictEqual(result.jobId, 'job-123');
  assert.ok(result.message.includes('Registered workflow'));
});
