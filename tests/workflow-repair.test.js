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

test('workflow repair plan applies auth-state plan into headers and browser replay bootstrap', () => {
  const plan = buildWorkflowRepairPlan({
    workflow: {
      name: 'repair-auth',
      seedUrls: ['https://example.com/account'],
      mode: 'browser',
      browser: {
        replay: {},
      },
      headers: {},
    },
    authStatePlan: {
      kind: 'auth-state-plan',
      loginWallDetected: true,
      loginWallReasons: ['login-copy'],
      sessionLikelyRequired: true,
      requiredCookies: ['session'],
      cookieValues: { session: 'abc123' },
      requiredHeaders: { authorization: 'Bearer token-1' },
      replayState: { csrfToken: 'csrf-1', access_token: 'token-1' },
      refreshLikely: true,
      csrfFields: ['csrfToken'],
    },
  });

  assert.equal(plan.authStatePlan.loginWallDetected, true);
  assert.equal(plan.patch.session.enabled, true);
  assert.equal(plan.patch.headers.authorization, 'Bearer token-1');
  assert.ok(plan.patch.browser.replay.initScripts.some((entry) => entry.includes('__OMNICRAWL_AUTH_STATE')));
  assert.equal(plan.patch.browser.replay.cookies[0].name, 'session');
  assert.equal(plan.patch.browser.replay.cookies[0].value, 'abc123');
  assert.ok(plan.reasons.some((entry) => entry.includes('login/session pressure')));
});
