import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import { once } from 'node:events';
import { buildWorkflowRepairPlan, registerAndRerunRepair } from '../src/runtime/workflow-repair.js';
import { buildReplayWorkflowFromRecording } from '../src/runtime/replay-workflow.js';
import { setupLoginRecorderRoutes } from '../src/routes/recorder-and-repair.js';

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

test('buildWorkflowRepairPlan - accepts authStatePlan input', () => {
  const workflow = {
    name: 'auth-plan-demo',
    mode: 'browser',
    seedUrls: ['https://example.com/login'],
    browser: { replay: {} },
    headers: {},
  };

  const plan = buildWorkflowRepairPlan({
    workflow,
    authStatePlan: {
      kind: 'auth-state-plan',
      loginWallDetected: true,
      loginWallReasons: ['login-copy'],
      sessionLikelyRequired: true,
      requiredCookies: ['session'],
      cookieValues: { session: 'abc' },
      requiredHeaders: { authorization: 'Bearer demo' },
      replayState: { csrfToken: 'csrf-1' },
      refreshLikely: false,
      csrfFields: ['csrfToken'],
    },
  });

  assert.strictEqual(plan.patch.headers.authorization, 'Bearer demo');
  assert.ok(plan.patch.browser.replay.cookies.some((entry) => entry.name === 'session'));
  assert.ok(plan.patch.browser.replay.initScripts.some((entry) => entry.includes('csrfToken')));
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

test('buildReplayWorkflowFromRecording converts recorded steps and auth state into browser replay workflow', () => {
  const workflow = buildReplayWorkflowFromRecording({
    session: {
      id: 'rec-1',
      name: 'Demo Login',
      url: 'https://example.com/login',
      steps: [
        { type: 'type', selector: '#username', value: 'demo@example.com' },
        { type: 'type', selector: '#password', value: 'secret' },
        { type: 'click', selector: '#submit', waitForNavigation: true },
        { type: 'wait', value: 1500, finalUrl: 'https://example.com/account', html: '<div id="account">ok</div>' },
      ],
      authStatePlan: {
        kind: 'auth-state-plan',
        loginWallDetected: true,
        loginWallReasons: ['login-copy'],
        sessionLikelyRequired: true,
        requiredCookies: ['session'],
        cookieValues: { session: 'abc123' },
        requiredHeaders: { authorization: 'Bearer token-1' },
        replayState: { csrfToken: 'csrf-1' },
        refreshLikely: false,
        csrfFields: ['csrfToken'],
      },
    },
  });

  assert.strictEqual(workflow.mode, 'browser');
  assert.strictEqual(workflow.browser.replay.steps[0].type, 'navigate');
  assert.strictEqual(workflow.browser.replay.steps[1].type, 'type');
  assert.strictEqual(workflow.browser.replay.steps[3].type, 'click');
  assert.strictEqual(workflow.browser.replay.finalUrl, 'https://example.com/account');
  assert.strictEqual(workflow.replay.successSelector, '#account');
  assert.ok(workflow.browser.replay.steps.some((entry) => entry.type === 'waitForSelector' && entry.selector === '#account'));
  assert.ok(workflow.browser.replay.steps.some((entry) => entry.type === 'extractState' && entry.source === 'localStorage' && entry.key === 'csrfToken'));
  assert.ok(workflow.browser.replay.steps.some((entry) => entry.type === 'extractState' && entry.source === 'cookie' && entry.key === 'session'));
  assert.strictEqual(workflow.headers.authorization, 'Bearer token-1');
  assert.ok(workflow.browser.replay.cookies.some((entry) => entry.name === 'session'));
  assert.ok(workflow.browser.replay.storageSeeds.some((entry) => entry.key === 'csrfToken'));
});

test('login recorder workflow export returns replayable workflow with auth seeds', async () => {
  const app = express();
  app.use(express.json());
  setupLoginRecorderRoutes(app, {});

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiBase = `http://127.0.0.1:${server.address().port}`;

  try {
    const startResponse = await fetch(`${apiBase}/api/login-recorder/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/login' }),
    });
    const started = await startResponse.json();

    await fetch(`${apiBase}/api/login-recorder/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'type',
        selector: '#username',
        value: 'demo@example.com',
      }),
    });

    await fetch(`${apiBase}/api/login-recorder/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'click',
        selector: '#submit',
        status: 401,
        headers: {
          'set-cookie': ['session=abc123; Path=/'],
          authorization: 'Bearer token-1',
        },
        body: JSON.stringify({ access_token: 'token-1' }),
        html: '<form><input type="hidden" name="csrfToken" value="csrf-1" /><input type="password" /></form>',
      }),
    });

    await fetch(`${apiBase}/api/login-recorder/stop`, {
      method: 'POST',
    });

    const workflowResponse = await fetch(`${apiBase}/api/login-recorder/sessions/${started.recording.id}/workflow`);
    const payload = await workflowResponse.json();

    assert.strictEqual(payload.sessionId, started.recording.id);
    assert.strictEqual(payload.workflow.mode, 'browser');
    assert.strictEqual(payload.workflow.seedUrls[0], 'https://example.com/login');
    assert.strictEqual(payload.workflow.headers.authorization, 'Bearer token-1');
    assert.ok(payload.workflow.browser.replay.cookies.some((entry) => entry.name === 'session'));
    assert.ok(payload.workflow.browser.replay.storageSeeds.some((entry) => entry.key === 'csrfToken'));
    assert.ok(payload.workflow.browser.replay.steps.some((entry) => entry.type === 'click' && entry.selector === '#submit'));

    const repairResponse = await fetch(`${apiBase}/api/login-recorder/sessions/${started.recording.id}/repair-plan`);
    const repairPayload = await repairResponse.json();

    assert.strictEqual(repairPayload.sessionId, started.recording.id);
    assert.strictEqual(repairPayload.repairPlan.patch.session.enabled, true);
    assert.strictEqual(repairPayload.repairPlan.patch.headers.authorization, 'Bearer token-1');
    assert.ok(repairPayload.repairPlan.patch.browser.replay.cookies.some((entry) => entry.name === 'session'));
  } finally {
    server.close();
    await once(server, 'close');
  }
});
