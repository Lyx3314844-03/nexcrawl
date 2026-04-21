import { test } from 'node:test';
import assert from 'node:assert';
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager, DEFAULT_CONFIG, setGlobalConfig } from '../../src/utils/config.js';
import { validateCode, validateUrl } from '../../src/utils/validation.js';
import { loadWorkflow } from '../../src/runtime/workflow-loader.js';

test('ConfigManager - default config', () => {
  const config = new ConfigManager();
  assert.strictEqual(config.get('performance.concurrency'), 10);
  assert.strictEqual(config.get('reverse.astCache.enabled'), true);
});

test('ConfigManager - merge user config', () => {
  const config = new ConfigManager({
    performance: { concurrency: 20 },
  });
  assert.strictEqual(config.get('performance.concurrency'), 20);
  assert.strictEqual(config.get('performance.timeout'), 30000); // default preserved
});

test('ConfigManager - set config', () => {
  const config = new ConfigManager();
  config.set('performance.concurrency', 50);
  assert.strictEqual(config.get('performance.concurrency'), 50);
});

test('ConfigManager - validation', () => {
  assert.throws(() => {
    new ConfigManager({ performance: { concurrency: 0 } });
  }, /concurrency must be >= 1/);
});

test('ConfigManager - get non-existent path', () => {
  const config = new ConfigManager();
  assert.strictEqual(config.get('nonexistent.path'), null);
});

test('global config influences validation defaults', () => {
  setGlobalConfig({
    security: {
      validation: {
        allowPrivateIPs: true,
        maxCodeLength: 8,
      },
    },
  });

  try {
    assert.strictEqual(validateUrl('http://127.0.0.1:3000/demo'), 'http://127.0.0.1:3000/demo');
    assert.throws(() => validateCode('123456789'), /maximum length of 8/);
  } finally {
    setGlobalConfig(DEFAULT_CONFIG);
  }
});

test('loadWorkflow applies global performance defaults and security validation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'omnicrawl-config-loader-'));
  const workflowPath = join(cwd, 'workflow.json');

  setGlobalConfig({
    performance: {
      concurrency: 7,
      timeout: 4321,
    },
    security: {
      validation: {
        allowPrivateIPs: true,
      },
    },
  });

  try {
    await writeFile(workflowPath, JSON.stringify({
      name: 'config-loader',
      seedUrls: ['http://127.0.0.1:3010/demo'],
      mode: 'http',
      extract: [],
      output: {
        dir: 'runs',
        persistBodies: false,
        console: false,
      },
    }, null, 2));

    const { workflow } = await loadWorkflow('workflow.json', { cwd });
    assert.strictEqual(workflow.concurrency, 7);
    assert.strictEqual(workflow.timeoutMs, 4321);
    assert.strictEqual(workflow.seedUrls[0], 'http://127.0.0.1:3010/demo');
  } finally {
    setGlobalConfig(DEFAULT_CONFIG);
    await rm(cwd, { recursive: true, force: true });
  }
});
