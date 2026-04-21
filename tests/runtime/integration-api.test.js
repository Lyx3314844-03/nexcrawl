import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../../src/server.js';

test('runtime integrations endpoint returns optional integration snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-integrations-api-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const response = await fetch(`${apiBase}/runtime/integrations`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.ok(payload.total >= 8);
    assert.ok(payload.items.some((item) => item.id === 'redis'));
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime integrations probe endpoint supports dry-run validation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-integration-probe-api-'));
  const runtime = await startServer({ port: 0, projectRoot: root });
  const apiBase = `http://127.0.0.1:${runtime.server.address().port}`;

  try {
    const response = await fetch(`${apiBase}/runtime/integrations/probe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        id: 'redis',
        dryRun: true,
        config: {
          url: 'redis://localhost:6379',
        },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.id, 'redis');
    assert.equal(payload.dryRun, true);
    assert.equal(payload.configValid, true);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
