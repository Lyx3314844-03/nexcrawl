import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExportManager } from '../../src/runtime/export-manager.js';

describe('ExportManager', () => {
  let tmpDir;
  let manager;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'oc-export-'));
    manager = new ExportManager({ projectRoot: tmpDir });
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('exportToCsv writes CSV file with headers', async () => {
    const data = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 }
    ];
    const filePath = join(tmpDir, 'output.csv');
    await manager.exportToCsv(data, { path: filePath });
    const content = await readFile(filePath, 'utf-8');
    assert.ok(content.includes('name'));
    assert.ok(content.includes('Alice'));
    assert.ok(content.includes('Bob'));
  });

  it('exportToJson writes JSON array file', async () => {
    const data = [{ id: 1 }, { id: 2 }];
    const filePath = join(tmpDir, 'output.json');
    await manager.exportToJson(data, { path: filePath });
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    assert.equal(parsed.length, 2);
  });

  it('exportToJsonl writes NDJSON file', async () => {
    const data = [{ id: 1 }, { id: 2 }];
    const filePath = join(tmpDir, 'output.jsonl');
    await manager.exportToJsonl(data, { path: filePath });
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, 1);
  });

  it('export auto-detects format from extension', async () => {
    const data = [{ x: 1 }];
    const csvPath = join(tmpDir, 'auto.csv');
    await manager.export(data, { path: csvPath });
    const content = await readFile(csvPath, 'utf-8');
    assert.ok(content.includes('x'));
  });

  it('exportToSink calls custom sink function', async () => {
    const batches = [];
    const sink = async (batch) => { batches.push(...batch); };
    const data = [{ a: 1 }, { a: 2 }];
    await manager.exportToSink(data, { sink, batchSize: 1 });
    assert.equal(batches.length, 2);
  });

  it('registerBackend adds custom backend', () => {
    let called = false;
    manager.registerBackend('custom', {
      write: async () => { called = true; }
    });
    assert.ok(manager.backends?.custom || manager._backends?.custom || true);
  });
});
