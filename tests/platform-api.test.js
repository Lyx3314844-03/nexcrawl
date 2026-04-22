import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { startServer } from '../src/server.js';

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const payload = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

test('platform API exposes login, protocol, app, anti-bot, orchestration, self-healing, and governance tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-platform-api-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const capabilities = await jsonFetch(`${apiBase}/capabilities`);
    assert.ok(capabilities.platform.includes('universal-crawl-planner'));
    assert.ok(capabilities.platform.includes('login-state-machine'));
    assert.ok(capabilities.platform.includes('interactive-auth-executor'));
    assert.ok(capabilities.platform.includes('credential-vault'));
    assert.ok(capabilities.platform.includes('tenant-registry'));
    assert.ok(capabilities.platform.includes('persistent-account-pool'));
    assert.ok(capabilities.platform.includes('rbac-access-policy'));
    assert.ok(capabilities.platform.includes('mobile-device-pool'));
    assert.ok(capabilities.platform.includes('attestation-compliance-gate'));

    const login = await jsonFetch(`${apiBase}/platform/login/analyze`, {
      method: 'POST',
      body: JSON.stringify({
        observation: {
          url: 'https://example.com/login',
          html: '<form><input type="password"><div>captcha required</div></form>',
        },
      }),
    });
    assert.equal(login.item.classification.state, 'captcha_challenge');
    assert.equal(login.item.plan.steps[0].type, 'solve-captcha');

    const universalPlan = await jsonFetch(`${apiBase}/platform/universal/plan`, {
      method: 'POST',
      body: JSON.stringify({
        url: 'https://example.com/graphql',
        body: 'mutation Login { login { token } }',
      }),
    });
    assert.ok(universalPlan.item.lanes.some((entry) => entry.type === 'graphql-semantics'));

    const interactiveLogin = await jsonFetch(`${apiBase}/platform/login/interactive-plan`, {
      method: 'POST',
      body: JSON.stringify({
        observation: {
          url: 'https://idp.example.com/oauth/authorize',
          html: '<div>Scan QR code and use passkey</div>',
        },
      }),
    });
    assert.equal(interactiveLogin.item.classification.requiresHuman, true);

    const challenge = await jsonFetch(`${apiBase}/platform/human-challenges`, {
      method: 'POST',
      body: JSON.stringify({ type: 'qr-login', tenantId: 't1', accountId: 'acct-1' }),
    });
    const resolvedChallenge = await jsonFetch(`${apiBase}/platform/human-challenges/${challenge.item.id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    });
    assert.equal(resolvedChallenge.item.status, 'resolved');

    const tenant = await jsonFetch(`${apiBase}/platform/tenants`, {
      method: 'POST',
      body: JSON.stringify({
        id: 't1',
        name: 'Tenant One',
        quotas: { running: 1, account: 1 },
      }),
    });
    assert.equal(tenant.item.id, 't1');

    const tenants = await jsonFetch(`${apiBase}/platform/tenants`);
    assert.equal(tenants.items.some((item) => item.id === 't1'), true);

    const quota = await jsonFetch(`${apiBase}/platform/orchestration/quotas`, {
      method: 'POST',
      body: JSON.stringify({
        tenantId: 't1',
        quota: { running: 2, browser: 1 },
      }),
    });
    assert.equal(quota.item.quota.browser, 1);

    const account = await jsonFetch(`${apiBase}/platform/accounts`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'acct-1',
        tenantId: 't1',
        siteId: 'shop',
        username: 'demo',
        labels: ['primary'],
      }),
    });
    assert.equal(account.item.id, 'acct-1');

    const accountLease = await jsonFetch(`${apiBase}/platform/accounts/lease`, {
      method: 'POST',
      body: JSON.stringify({
        scope: { tenantId: 't1', siteId: 'shop', labels: ['primary'] },
      }),
    });
    assert.equal(accountLease.item.id, 'acct-1');

    const accountRelease = await jsonFetch(`${apiBase}/platform/accounts/release`, {
      method: 'POST',
      body: JSON.stringify({
        accountId: 'acct-1',
        result: { ok: false, penalty: 10 },
      }),
    });
    assert.equal(accountRelease.item.failureCount, 1);

    const access = await jsonFetch(`${apiBase}/platform/governance/access/evaluate`, {
      method: 'POST',
      body: JSON.stringify({
        tenantId: 't1',
        roles: ['admin'],
        action: 'platform.accounts.lease',
        resource: 'tenant:t1:accounts',
      }),
    });
    assert.equal(access.item.allowed, true);

    const reservation = await jsonFetch(`${apiBase}/platform/orchestration/reserve`, {
      method: 'POST',
      body: JSON.stringify({
        tenantId: 't1',
        resources: { browser: 1 },
      }),
    });
    assert.equal(reservation.accepted, true);

    const device = await jsonFetch(`${apiBase}/platform/devices`, {
      method: 'POST',
      body: JSON.stringify({ id: 'emulator-1', platform: 'android', labels: ['test'] }),
    });
    assert.equal(device.item.id, 'emulator-1');

    const deviceLease = await jsonFetch(`${apiBase}/platform/devices/lease`, {
      method: 'POST',
      body: JSON.stringify({ scope: { platform: 'android', labels: ['test'] } }),
    });
    assert.equal(deviceLease.item.id, 'emulator-1');

    const mobilePlan = await jsonFetch(`${apiBase}/platform/mobile-app/execution-plan`, {
      method: 'POST',
      body: JSON.stringify({ app: { packageName: 'com.demo', apkPath: 'demo.apk' }, capture: { reinstall: true } }),
    });
    assert.ok(mobilePlan.item.steps.some((step) => step.type === 'launch-app'));

    const mobileDryRun = await jsonFetch(`${apiBase}/platform/mobile-app/execute-plan`, {
      method: 'POST',
      body: JSON.stringify({ plan: mobilePlan.item, dryRun: true }),
    });
    assert.equal(mobileDryRun.item.events.length, mobilePlan.item.steps.length);

    const attestation = await jsonFetch(`${apiBase}/platform/attestation/compliance-plan`, {
      method: 'POST',
      body: JSON.stringify({ signal: { status: 403, body: 'SafetyNet attestation failed' } }),
    });
    assert.equal(attestation.item.policy, 'do-not-bypass');

    const appPlan = await jsonFetch(`${apiBase}/platform/app-capture/plan`, {
      method: 'POST',
      body: JSON.stringify({
        app: { packageName: 'com.demo', apkPath: 'demo.apk' },
        capture: { reinstall: true, safetyNet: true },
      }),
    });
    assert.ok(appPlan.item.steps.some((step) => step.type === 'start-network-capture'));
    assert.ok(appPlan.item.unsupportedClosedLoop.includes('safetynet'));

    const protocol = await jsonFetch(`${apiBase}/platform/protocol/semantics`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'graphql',
        schema: {
          queryType: 'Query',
          mutationType: 'Mutation',
          types: [
            { name: 'Query', fields: [{ name: 'searchProducts', type: '[Product]', args: [] }] },
            { name: 'Mutation', fields: [{ name: 'login', type: 'Session', args: [{ name: 'password', type: 'String' }] }] },
          ],
        },
      }),
    });
    assert.equal(protocol.item.criticalOperations[0].fieldName, 'login');

    const matrix = await jsonFetch(`${apiBase}/platform/anti-bot/experiments`, {
      method: 'POST',
      body: JSON.stringify({
        siteId: 'demo',
        proxies: [{ server: 'http://proxy-a' }],
        identities: [{ userAgent: 'ua' }],
        browsers: [{ engine: 'chromium' }],
      }),
    });
    assert.equal(matrix.total, 1);

    const antiBotResult = await jsonFetch(`${apiBase}/platform/anti-bot/results`, {
      method: 'POST',
      body: JSON.stringify({
        siteId: 'demo',
        success: false,
        body: 'enable javascript to continue',
      }),
    });
    assert.equal(antiBotResult.degraded.detected, true);
    assert.equal(antiBotResult.successRates[0].degradedRate, 1);

    const dag = await jsonFetch(`${apiBase}/platform/orchestration/dag-plan`, {
      method: 'POST',
      body: JSON.stringify({
        nodes: [
          { id: 'login' },
          { id: 'crawl', dependsOn: ['login'] },
        ],
      }),
    });
    assert.deepEqual(dag.item.waves, [['login'], ['crawl']]);

    const schema = await jsonFetch(`${apiBase}/platform/data/schema/evolve`, {
      method: 'POST',
      body: JSON.stringify({
        schema: { version: 1, fields: { id: { type: 'string' } } },
        observedFields: { id: '1', price: 9.9 },
      }),
    });
    assert.equal(schema.item.version, 2);
    assert.equal(schema.item.fields.price.type, 'number');

    const patch = await jsonFetch(`${apiBase}/platform/self-healing/patch-plan`, {
      method: 'POST',
      body: JSON.stringify({
        recording: {
          steps: [
            { type: 'type', selector: '#email', value: 'demo@example.com' },
            { type: 'type', selector: '#password', value: 'secret' },
          ],
        },
        failure: { selector: '#login' },
        observations: [{ success: true, html: '<button>logout</button>' }],
      }),
    });
    assert.equal(patch.item.generalizedSteps[0].value, '{{credentials.username}}');
    assert.ok(patch.item.selectorRepair.alternatives.includes('[data-testid="login"]'));

    const credential = await jsonFetch(`${apiBase}/platform/governance/credentials`, {
      method: 'POST',
      body: JSON.stringify({
        tenantId: 't1',
        name: 'api',
        value: 'secret-token',
        scope: ['crawl'],
      }),
    });
    assert.equal(credential.item.id, 't1:api');
    assert.equal('value' in credential.item, false);

    const credentialMeta = await jsonFetch(`${apiBase}/platform/governance/credentials/t1/api`);
    assert.equal(credentialMeta.item.fingerprint, credential.item.fingerprint);
    assert.equal('value' in credentialMeta.item, false);

    await jsonFetch(`${apiBase}/platform/governance/audit`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'test.secret',
        tenantId: 't1',
        details: { token: 'do-not-leak' },
      }),
    });
    const audit = await jsonFetch(`${apiBase}/platform/governance/audit`);
    assert.ok(audit.items.some((item) => item.action === 'credential.create'));
    assert.ok(audit.items.some((item) => item.details?.token === '***REDACTED***'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
