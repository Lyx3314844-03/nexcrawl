import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  AccountPool,
  AccessPolicy,
  AntiBotLab,
  AuditLogger,
  CredentialVault,
  DevicePool,
  HumanInteractionBroker,
  LoginStateMachine,
  buildAttestationCompliancePlan,
  buildAppCapturePlan,
  buildAutoPatchPlan,
  buildDagExecutionPlan,
  buildInteractiveLoginPlan,
  buildMobileAppExecutionPlan,
  classifyLoginObservation,
  createLineageRecord,
  detectDegradedPage,
  executeMobileAppPlan,
  evolveSchemaVersion,
  inferGraphQLSemantics,
  inferGrpcSemantics,
  inferWebSocketSemantics,
  mergeAppCaptureStreams,
  ResourceScheduler,
  TenantRegistry,
  analyzeUniversalTarget,
  buildUniversalCrawlPlan,
} from '../src/index.js';

test('login state machine classifies challenges and builds renewal plans', () => {
  const login = classifyLoginObservation({
    url: 'https://example.com/login',
    html: '<form><input type="password"><div>captcha required</div></form>',
  });
  assert.equal(login.state, 'captcha_challenge');
  assert.equal(login.recoverable, true);

  const machine = new LoginStateMachine({ renewBeforeMs: 1000 });
  machine.observe({ status: 401, body: 'session expired, please login again' });
  const plan = machine.plan({ accountId: 'acct-1' });
  assert.equal(plan.state, 'expired');
  assert.equal(plan.steps[0].type, 'renew-session');
  assert.equal(machine.isSessionExpiring({ expiresAtMs: Date.now() + 500 }), true);
});

test('interactive auth plans cover SSO QR passkey and risk review', async () => {
  const plan = buildInteractiveLoginPlan({
    url: 'https://idp.example.com/oauth/authorize',
    html: '<div>Scan QR code or use passkey. Verify your identity due to unusual activity.</div>',
  });
  assert.equal(plan.classification.requiresHuman, true);
  assert.ok(plan.steps.some((step) => step.type === 'follow-sso'));
  assert.ok(plan.steps.some((step) => step.type === 'human-scan-qr'));
  assert.ok(plan.steps.some((step) => step.type === 'human-passkey-confirm'));
  assert.ok(plan.steps.some((step) => step.type === 'human-risk-review'));

  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-human-'));
  const broker = await new HumanInteractionBroker({
    defaultTimeoutMs: 1000,
    path: join(root, 'human.json'),
  }).init();
  const challenge = broker.createChallenge({ type: 'qr-login', tenantId: 't1', accountId: 'a1' });
  assert.equal(broker.list({ status: 'pending' }).length, 1);
  assert.equal(broker.resolveChallenge(challenge.id, { ok: true }).status, 'resolved');
  await broker.flush();
  const reloaded = await new HumanInteractionBroker({ path: join(root, 'human.json') }).init();
  assert.equal(reloaded.list({ status: 'resolved' })[0].id, challenge.id);
  await rm(root, { recursive: true, force: true });
});

test('universal crawl planner routes targets into safe execution lanes', () => {
  const browserPlan = buildUniversalCrawlPlan({
    url: 'https://example.com/app',
    html: '<div id="root"></div><script>window.__APP__={}</script>',
  });
  assert.ok(browserPlan.lanes.some((entry) => entry.type === 'browser-crawl'));
  assert.equal(browserPlan.runnable, true);

  const graphql = analyzeUniversalTarget({
    url: 'https://example.com/graphql',
    body: 'query SearchProducts { products { id } }',
  });
  assert.equal(graphql.sourceKind, 'graphql');

  const risky = buildUniversalCrawlPlan({
    app: { packageName: 'com.demo' },
    body: 'Play Integrity attestation failed. Scan QR code to continue.',
  });
  assert.ok(risky.lanes.some((entry) => entry.type === 'mobile-app-execution'));
  assert.ok(risky.lanes.some((entry) => entry.type === 'attestation-compliance'));
  assert.ok(risky.lanes.some((entry) => entry.type === 'interactive-auth'));
  assert.equal(risky.runnable, false);
});

test('account pool leases by tenant and quarantines failing accounts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-accounts-'));
  const pool = new AccountPool({
    path: join(root, 'accounts.json'),
    maxConsecutiveFailures: 1,
    accounts: [
      { id: 'a1', tenantId: 't1', siteId: 'shop', score: 20 },
      { id: 'a2', tenantId: 't1', siteId: 'shop', score: 90 },
      { id: 'a3', tenantId: 't2', siteId: 'shop', score: 100 },
    ],
  });

  const leased = pool.lease({ tenantId: 't1', siteId: 'shop' });
  assert.equal(leased.id, 'a2');
  const released = pool.release('a2', { ok: false });
  assert.ok(released.cooldownUntil > Date.now());
  assert.equal(pool.lease({ tenantId: 't1', siteId: 'shop' }).id, 'a1');
  await pool.flush();

  const reloaded = await new AccountPool({ path: join(root, 'accounts.json') }).init();
  assert.equal(reloaded.snapshot().find((item) => item.id === 'a2').failureCount, 1);
  await rm(root, { recursive: true, force: true });
});

test('app capture plan models device, cert, frida, network, and stream merge steps', () => {
  const plan = buildAppCapturePlan({
    app: { packageName: 'com.demo.app', apkPath: 'demo.apk' },
    capture: { reinstall: true, playIntegrity: true },
  });
  assert.ok(plan.steps.some((step) => step.type === 'install-ca-certificate'));
  assert.ok(plan.steps.some((step) => step.type === 'start-frida'));
  assert.ok(plan.unsupportedClosedLoop.includes('play-integrity'));

  const model = mergeAppCaptureStreams({
    pageTree: [{ activity: '.MainActivity', controls: [{ text: 'Buy' }] }],
    networkFlows: [{ requestId: 'r1', url: 'https://api.example.com/items' }],
    hookEvents: [{ requestId: 'r1', method: 'signRequest' }],
  });
  assert.equal(model.screens.length, 1);
  assert.equal(model.endpoints[0].hooks[0].method, 'signRequest');
});

test('mobile device pool and app execution plan model app-side closed loop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-devices-'));
  const pool = await new DevicePool({
    path: join(root, 'devices.json'),
    devices: [{ id: 'emulator-1', platform: 'android', labels: ['test'] }],
  }).init();
  const leased = pool.lease({ platform: 'android', labels: ['test'] });
  assert.equal(leased.id, 'emulator-1');
  assert.equal(pool.release('emulator-1', { ok: true }).status, 'available');
  await pool.flush();
  const reloadedPool = await new DevicePool({ path: join(root, 'devices.json') }).init();
  assert.equal(reloadedPool.snapshot()[0].id, 'emulator-1');

  const plan = buildMobileAppExecutionPlan({
    app: { packageName: 'com.demo', apkPath: 'demo.apk' },
    capture: { reinstall: true },
  });
  assert.ok(plan.steps.some((step) => step.type === 'install-app'));
  assert.ok(plan.steps.some((step) => step.type === 'start-frida-session'));
  const result = await executeMobileAppPlan(plan, {}, { dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.events.length, plan.steps.length);
  await rm(root, { recursive: true, force: true });
});

test('attestation compliance gate detects strong platform integrity checks without bypassing', () => {
  const plan = buildAttestationCompliancePlan({
    status: 403,
    body: 'Play Integrity device reputation failed',
  });
  assert.equal(plan.detected, true);
  assert.equal(plan.policy, 'do-not-bypass');
  assert.ok(plan.blockedActions.includes('forge-integrity-token'));
  assert.ok(plan.allowedActions.includes('manual-review'));
});

test('protocol semantics rank GraphQL operations and infer WS/gRPC models', () => {
  const gql = inferGraphQLSemantics({
    queryType: 'Query',
    mutationType: 'Mutation',
    types: [
      { name: 'Query', fields: [{ name: 'searchProducts', type: '[Product]', args: [{ name: 'q', type: 'String' }] }] },
      { name: 'Mutation', fields: [{ name: 'login', type: 'Session', args: [{ name: 'password', type: 'String' }] }] },
    ],
  });
  assert.equal(gql.criticalOperations[0].fieldName, 'login');

  const ws = inferWebSocketSemantics([
    { direction: 'out', payload: { action: 'subscribe', channel: 'prices' } },
    { direction: 'in', payload: { type: 'ping' } },
  ]);
  assert.equal(ws.subscriptionModel, 'explicit-subscribe');
  assert.equal(ws.heartbeat.required, true);

  const grpc = inferGrpcSemantics([
    { fields: [{ id: 1, type: 'string', value: 'session-token' }] },
    { fields: [{ id: 1, type: 'string', value: 'other-token' }] },
  ]);
  assert.equal(grpc.messageTypes.length, 1);
  assert.ok(grpc.messageTypes[0].semanticHints.includes('auth'));
});

test('anti-bot lab records experiment success rates and degraded pages', () => {
  const lab = new AntiBotLab({ fingerprintTemplates: [{ siteId: 'demo', version: 'chrome-124' }] });
  const matrix = lab.buildExperimentMatrix({
    siteId: 'demo',
    proxies: [{ server: 'http://p1' }],
    identities: [{ userAgent: 'ua' }],
    browsers: [{ engine: 'chromium' }],
  });
  assert.equal(matrix.length, 1);

  lab.recordExperiment({ siteId: 'demo', success: false, status: 200, body: 'enable javascript to continue' });
  assert.equal(lab.successRates()[0].degradedRate, 1);
  assert.equal(detectDegradedPage({ status: 429 }).detected, true);
});

test('anti-bot lab can persist and reload experiment snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-antibot-'));
  try {
    const statePath = join(root, 'anti-bot.json');
    const lab = await new AntiBotLab({ path: statePath }).init();
    lab.addFingerprintTemplate({ siteId: 'demo', version: 'chrome-124' });
    lab.recordExperiment({ siteId: 'demo', success: true, body: '<html>ok</html>' });
    await lab.flush();

    const reloaded = await new AntiBotLab({ path: statePath }).init();
    assert.equal(reloaded.buildExperimentMatrix({ siteId: 'demo' })[0].fingerprintTemplate.version, 'chrome-124');
    assert.equal(reloaded.successRates()[0].successRate, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resource scheduler, DAG planner, lineage, and schema evolution cover platform orchestration', () => {
  const scheduler = new ResourceScheduler({ quotas: { t1: { running: 1, browser: 1 } } });
  assert.ok(scheduler.reserve({ tenantId: 't1', resources: { browser: 1 } }));
  assert.equal(scheduler.canRun({ tenantId: 't1', resources: { browser: 1 } }), false);
  scheduler.release({ tenantId: 't1', resources: { browser: 1 } });
  scheduler.setQuota('t2', { running: 2, account: 1 });
  assert.equal(scheduler.snapshot().quotas.t2.account, 1);

  const dag = buildDagExecutionPlan([
    { id: 'login' },
    { id: 'crawl', dependsOn: ['login'] },
    { id: 'export', dependsOn: ['crawl'] },
  ]);
  assert.deepEqual(dag.waves, [['login'], ['crawl'], ['export']]);

  const lineage = createLineageRecord({ jobId: 'j1', input: { dataset: 'raw' }, output: { dataset: 'clean' } });
  assert.equal(lineage.jobId, 'j1');

  const evolved = evolveSchemaVersion({ version: 1, fields: { id: { type: 'string' } } }, { id: '1', price: 12 });
  assert.equal(evolved.version, 2);
  assert.equal(evolved.fields.price.type, 'number');
});

test('tenant registry persists tenant metadata and quotas', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-tenants-'));
  try {
    const registryPath = join(root, 'tenants.json');
    const registry = await new TenantRegistry({ path: registryPath }).init();
    registry.upsert({
      id: 'tenant-a',
      name: 'Tenant A',
      quotas: { running: 2, browser: 1 },
      roles: [{ userId: 'u1', role: 'operator' }],
    });
    await registry.flush();

    const reloaded = await new TenantRegistry({ path: registryPath }).init();
    assert.equal(reloaded.get('tenant-a').quotas.browser, 1);
    assert.equal(reloaded.list().length, 1);
    assert.equal(reloaded.setStatus('tenant-a', 'disabled').status, 'disabled');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('access policy enforces tenant role action and resource rules', () => {
  const policy = new AccessPolicy({
    policies: [
      { id: 'allow-ops', effect: 'allow', tenants: ['t1'], roles: ['operator'], actions: ['platform.*'], resources: ['tenant:t1:*'] },
      { id: 'deny-secrets', effect: 'deny', tenants: ['t1'], roles: ['operator'], actions: ['platform.governance.credentials.resolve'], resources: ['*'] },
    ],
  });

  assert.equal(policy.evaluate({
    tenantId: 't1',
    roles: ['operator'],
    action: 'platform.accounts.lease',
    resource: 'tenant:t1:accounts',
  }).allowed, true);
  assert.equal(policy.evaluate({
    tenantId: 't1',
    roles: ['operator'],
    action: 'platform.governance.credentials.resolve',
    resource: 'tenant:t1:credentials',
  }).allowed, false);
  assert.equal(policy.evaluate({
    tenantId: 't2',
    roles: ['operator'],
    action: 'platform.accounts.lease',
    resource: 'tenant:t2:accounts',
  }).reason, 'default-deny');
});

test('self-healing patch plans generalize credentials and suggest selector repairs', () => {
  const plan = buildAutoPatchPlan({
    recording: {
      steps: [
        { type: 'type', selector: '#email', value: 'demo@example.com' },
        { type: 'type', selector: '#password', value: 'secret' },
      ],
    },
    failure: { selector: '#login' },
    observations: [{ success: true, finalUrl: 'https://example.com/account', cookies: [{ name: 'sid' }] }],
  });

  assert.equal(plan.generalizedSteps[0].value, '{{credentials.username}}');
  assert.equal(plan.generalizedSteps[1].value, '{{credentials.password}}');
  assert.ok(plan.selectorRepair.alternatives.includes('[data-testid="login"]'));
  assert.equal(plan.successPredicate.cookieRequired, true);
});

test('audit logger redacts details and credential vault isolates tenant scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-audit-'));
  try {
    const auditPath = join(root, 'audit.ndjson');
    const logger = new AuditLogger({ path: auditPath, actor: 'tester' });
    await logger.record('credential.read', {
      tenantId: 't1',
      details: { token: 'secret-token', resource: 'vault' },
    });
    const raw = await readFile(auditPath, 'utf8');
    assert.match(raw, /\*\*\*REDACTED\*\*\*/);
    const reloadedLogger = await new AuditLogger({ path: auditPath }).init();
    assert.equal(reloadedLogger.list()[0].details.token, '***REDACTED***');

    const vaultPath = join(root, 'credentials.json');
    const vault = await new CredentialVault({ path: vaultPath, masterKey: 'test-master-key' }).init();
    const stored = vault.put({ tenantId: 't1', name: 'api', value: 'secret', scope: ['crawl'] });
    await vault.flush();
    assert.equal(vault.resolve(stored.id, { tenantId: 't1', scope: 'crawl' }), 'secret');
    assert.equal(vault.resolve(stored.id, { tenantId: 't2', scope: 'crawl' }), null);
    assert.equal(vault.describe(stored.id).value, undefined);
    assert.equal(vault.describe(stored.id).encryptedAtRest, true);

    const reloadedVault = await new CredentialVault({ path: vaultPath, masterKey: 'test-master-key' }).init();
    assert.equal(reloadedVault.resolve(stored.id, { tenantId: 't1', scope: 'crawl' }), 'secret');
    const storedRaw = await readFile(vaultPath, 'utf8');
    assert.doesNotMatch(storedRaw, /secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
