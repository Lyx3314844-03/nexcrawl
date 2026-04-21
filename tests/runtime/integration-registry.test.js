import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectOptionalIntegrations,
  probeIntegration,
  probeIntegrations,
} from '../../src/runtime/integration-registry.js';

test('inspectOptionalIntegrations reports known integrations and env hints', () => {
  const snapshot = inspectOptionalIntegrations({
    env: {
      OMNICRAWL_REDIS_URL: 'redis://localhost:6379',
      OMNICRAWL_SMTP_HOST: 'smtp.example.com',
    },
  });

  assert.ok(snapshot.total >= 8);
  assert.ok(snapshot.items.some((item) => item.id === 'redis' && item.envConfigured === true));
  assert.ok(snapshot.items.some((item) => item.id === 'smtp' && item.envConfigured === true));
});

test('probeIntegration dry-run validates config shape without network access', async () => {
  const result = await probeIntegration({
    id: 'redis',
    dryRun: true,
    config: {
      url: 'redis://localhost:6379',
    },
  });

  assert.equal(result.id, 'redis');
  assert.equal(result.dryRun, true);
  assert.equal(result.configValid, true);
  assert.equal(typeof result.ok, 'boolean');
});

test('probeIntegration reports invalid config in dry-run mode', async () => {
  const result = await probeIntegration({
    id: 'smtp',
    dryRun: true,
    config: {},
  });

  assert.equal(result.id, 'smtp');
  assert.equal(result.configValid, false);
  assert.equal(result.status, 'config-invalid');
});

test('probeIntegrations can batch dry-run multiple integrations', async () => {
  const result = await probeIntegrations({
    ids: ['redis', 'smtp'],
    dryRun: true,
    configs: {
      redis: { url: 'redis://localhost:6379' },
      smtp: { host: 'smtp.example.com' },
    },
  });

  assert.equal(result.total, 2);
  assert.equal(result.items.length, 2);
  assert.ok(result.items.some((item) => item.id === 'redis'));
  assert.ok(result.items.some((item) => item.id === 'smtp'));
});
