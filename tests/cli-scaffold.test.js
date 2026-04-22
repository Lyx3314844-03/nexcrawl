import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('cli scaffold builds a runnable workflow from a universal target spec', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-scaffold-'));
  const cliPath = resolve('src/cli.js');
  const inputPath = join(root, 'target.json');

  try {
    await writeFile(inputPath, JSON.stringify({
      url: 'https://example.com/graphql',
      body: 'query Viewer { viewer { id } }',
      variables: { locale: 'zh-CN' },
    }, null, 2));

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'scaffold',
      'target.json',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const outputPath = stdout.trim();
    assert.equal(outputPath, join(root, 'target.workflow.json'));

    const workflow = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(workflow.mode, 'http');
    assert.equal(workflow.request.method, 'POST');
    assert.equal(workflow.seedRequests[0].method, 'POST');
    assert.equal(
      workflow.seedRequests[0].body,
      JSON.stringify({ query: 'query Viewer { viewer { id } }', variables: { locale: 'zh-CN' } }),
    );
    assert.ok(workflow.extract.some((rule) => rule.name === 'data' && rule.type === 'json'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cli scaffold preserves starter behavior when the target path does not exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-starter-'));
  const cliPath = resolve('src/cli.js');

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'scaffold',
      'generated.workflow.json',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const outputPath = stdout.trim();
    assert.equal(outputPath, join(root, 'generated.workflow.json'));

    const workflow = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(workflow.name, 'starter-workflow');
    assert.deepEqual(workflow.seedUrls, ['https://example.com']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cli scaffold does not duplicate the .workflow suffix for existing workflow spec inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-workflow-name-'));
  const cliPath = resolve('src/cli.js');
  const inputPath = join(root, 'existing.workflow.json');

  try {
    await writeFile(inputPath, JSON.stringify({
      seedUrl: 'https://example.com',
      sourceType: 'static-page',
      extractPreset: 'title-links',
    }, null, 2));

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'scaffold',
      'existing.workflow.json',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    assert.equal(stdout.trim(), inputPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cli scaffold writes a runnable workflow for gRPC targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-grpc-scaffold-'));
  const cliPath = resolve('src/cli.js');
  const inputPath = join(root, 'grpc-target.json');

  try {
    await writeFile(inputPath, JSON.stringify({
      url: 'https://grpc.example.com',
      body: 'application/grpc proto service Catalog { rpc Search (SearchRequest) returns (SearchResponse); }',
      service: 'catalog.CatalogService',
      rpcMethod: 'Search',
      request: { query: 'shoes' },
    }, null, 2));

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'scaffold',
      'grpc-target.json',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const outputPath = stdout.trim();
    assert.equal(outputPath, join(root, 'grpc-target.workflow.json'));

    const workflow = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(workflow.request.method, 'POST');
    assert.equal(workflow.grpc.service, 'catalog.CatalogService');
    assert.equal(workflow.grpc.method, 'Search');
    assert.equal(workflow.seedRequests[0].grpc.service, 'catalog.CatalogService');
    assert.equal(workflow.seedRequests[0].grpc.method, 'Search');
    assert.equal(workflow.seedRequests[0].body, JSON.stringify({ query: 'shoes' }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
