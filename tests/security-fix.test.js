import { test } from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { startServer } from '../src/server.js';
import { writeJson } from '../src/utils/fs.js';

test('API Key authentication rejects unauthorized requests', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-test-'));
  const apiKey = 'test-secret-key';
  
  const { server, close } = await startServer({
    port: 0, // OS assigned
    projectRoot,
    apiKey,
  });
  
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await t.test('rejects request without api key', async () => {
      const res = await fetch(`${baseUrl}/health`);
      assert.strictEqual(res.status, 401);
      const body = await res.json();
      assert.strictEqual(body.error, 'unauthorized: valid api key required');
    });

    await t.test('rejects request with wrong api key', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { 'x-api-key': 'wrong-key' }
      });
      assert.strictEqual(res.status, 401);
    });

    await t.test('accepts request with correct api key in header', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { 'x-api-key': apiKey }
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
    });

    await t.test('rejects request with correct api key in query', async () => {
      const res = await fetch(`${baseUrl}/health?apiKey=${apiKey}`);
      assert.strictEqual(res.status, 401);
    });

    await t.test('accepts request with correct bearer token', async () => {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'ok');
    });
  } finally {
    await close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('startServer binds to loopback by default', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-bind-test-'));
  const { server, close } = await startServer({
    port: 0,
    projectRoot,
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    assert.strictEqual(address.address, '127.0.0.1');
  } finally {
    await close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('structured errors are serialized at the HTTP boundary', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-error-test-'));
  const { server, close } = await startServer({
    port: 0,
    projectRoot,
  });

  try {
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const res = await fetch(`${baseUrl}/workflows`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        workflow: {
          name: 'broken-workflow',
          seedUrls: ['notaurl'],
          mode: 'http',
          extract: [],
          output: {
            dir: 'runs',
            persistBodies: false,
            console: false,
          },
        },
      }),
    });

    assert.strictEqual(res.status, 400);
    const body = await res.json();
    assert.strictEqual(body.code, 'SCHEMA_VALIDATION_ERROR');
    assert.ok(Array.isArray(body.details.issues));
  } finally {
    await close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('writeJson is atomic (manual check of logic)', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'omnicrawl-fs-test-'));
  const targetPath = join(projectRoot, 'test.json');
  
  await writeJson(targetPath, { hello: 'world' });
  const content = await readFile(targetPath, 'utf8');
  assert.deepStrictEqual(JSON.parse(content), { hello: 'world' });
  
  await rm(projectRoot, { recursive: true, force: true });
});
