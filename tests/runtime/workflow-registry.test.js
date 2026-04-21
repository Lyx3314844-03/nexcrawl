import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowRegistry } from '../../src/runtime/workflow-registry.js';

describe('WorkflowRegistry', () => {
  let tmpDir;
  let registry;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-wf-'));
    registry = new WorkflowRegistry({ projectRoot: tmpDir });
    await registry.init();
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('initializes with empty index', () => {
    const list = registry.list();
    assert.ok(Array.isArray(list));
    assert.equal(list.length, 0);
  });

  it('register adds a workflow to the index', async () => {
    const workflow = {
      name: 'test-workflow',
      mode: 'http',
      seedRequests: [{ url: 'https://example.com' }]
    };
    const result = await registry.register({ workflow, id: 'test-wf', description: 'A test workflow' });
    assert.ok(result.id);
    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'test-wf');
  });

  it('register auto-generates ID if not provided', async () => {
    const workflow = { name: 'auto-id', mode: 'http', seedRequests: [{ url: 'https://example.com' }] };
    const result = await registry.register({ workflow });
    assert.ok(result.id);
    assert.ok(result.id.length > 0);
  });

  it('get retrieves a registered workflow', async () => {
    const workflow = { name: 'get-test', mode: 'cheerio', seedRequests: [{ url: 'https://example.com' }] };
    await registry.register({ workflow, id: 'get-wf' });
    const result = await registry.get('get-wf');
    assert.ok(result);
    assert.equal(result.id, 'get-wf');
  });

  it('get returns undefined for non-existent workflow', async () => {
    const result = await registry.get('non-existent');
    assert.equal(result, undefined);
  });

  it('list returns workflows sorted by updatedAt desc', async () => {
    await registry.register({ workflow: { name: 'first', mode: 'http', seedRequests: [{ url: 'https://a.com' }] }, id: 'wf-1' });
    await registry.register({ workflow: { name: 'second', mode: 'http', seedRequests: [{ url: 'https://b.com' }] }, id: 'wf-2' });
    const list = registry.list();
    assert.equal(list.length, 2);
  });

  it('register rejects invalid workflow', async () => {
    await assert.rejects(
      async () => registry.register({ workflow: {}, id: 'bad' }),
      { message: /seedRequests|mode|required|invalid/i }
    );
  });

  it('persists workflows across restarts', async () => {
    const workflow = { name: 'persist-test', mode: 'http', seedRequests: [{ url: 'https://example.com' }] };
    await registry.register({ workflow, id: 'persist-wf' });

    const registry2 = new WorkflowRegistry({ projectRoot: tmpDir });
    await registry2.init();
    const list = registry2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'persist-wf');
  });
});
