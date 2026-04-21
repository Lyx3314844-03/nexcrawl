import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';
import { slugify } from '../utils/slug.js';

function nowIso() {
  return new Date().toISOString();
}

function safeStoreDirName(storeId) {
  return `${slugify(storeId) || 'store'}-${hashText(storeId).slice(0, 12)}`;
}

function safeRecordName(key, extension = '.json') {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `${slugify(key) || 'record'}-${hashText(key).slice(0, 12)}${ext}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export class KeyValueStore {
  constructor({ projectRoot = process.cwd(), storeId, metadata = {} } = {}) {
    if (!storeId) {
      throw new Error('storeId is required');
    }

    this.projectRoot = projectRoot;
    this.storeId = storeId;
    this.metadata = metadata;
    this.storageDir = resolve(projectRoot, '.omnicrawl', 'key-value-stores');
    this.indexPath = join(this.storageDir, 'index.json');
    this.storeDir = join(this.storageDir, safeStoreDirName(storeId));
    this.manifestPath = join(this.storeDir, 'manifest.json');
    this.recordsDir = join(this.storeDir, 'records');
    this.manifest = null;
    this.initPromise = null;
  }

  static async list({ projectRoot = process.cwd(), limit = 100 } = {}) {
    const storageDir = resolve(projectRoot, '.omnicrawl', 'key-value-stores');
    const indexPath = join(storageDir, 'index.json');

    try {
      return toArray(await readJson(indexPath))
        .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  static async get({ projectRoot = process.cwd(), storeId } = {}) {
    const storageDir = resolve(projectRoot, '.omnicrawl', 'key-value-stores');
    const manifestPath = join(storageDir, safeStoreDirName(storeId), 'manifest.json');

    try {
      return await readJson(manifestPath);
    } catch {
      return null;
    }
  }

  static async getRecord({ projectRoot = process.cwd(), storeId, key } = {}) {
    const manifest = await KeyValueStore.get({ projectRoot, storeId });
    const record = manifest?.records?.find((item) => item.key === key);
    if (!record) {
      return undefined;
    }

    const storageDir = resolve(projectRoot, '.omnicrawl', 'key-value-stores');
    const targetPath = join(storageDir, safeStoreDirName(storeId), 'records', record.fileName);
    const raw = await readFile(targetPath, 'utf8');

    return {
      ...record,
      value: record.contentType === 'application/json' ? JSON.parse(raw) : raw,
    };
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        await ensureDir(this.storeDir);
        await ensureDir(this.recordsDir);

        try {
          this.manifest = await readJson(this.manifestPath);
        } catch {
          const now = nowIso();
          this.manifest = {
            id: this.storeId,
            createdAt: now,
            updatedAt: now,
            metadata: this.metadata,
            records: [],
          };
          await writeJson(this.manifestPath, this.manifest);
          await this.updateIndex();
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async updateIndex() {
    const current = toArray(await readJson(this.indexPath).catch(() => []));
    const summary = {
      id: this.manifest.id,
      createdAt: this.manifest.createdAt,
      updatedAt: this.manifest.updatedAt,
      metadata: this.manifest.metadata,
      recordCount: this.manifest.records.length,
    };
    const next = current.filter((item) => item.id !== this.storeId);
    next.unshift(summary);
    await writeJson(this.indexPath, next);
  }

  async setRecord(key, value, { contentType = 'application/json' } = {}) {
    await this.init();

    const isJson = contentType === 'application/json';
    const extension = isJson ? '.json' : '.txt';
    const fileName = safeRecordName(key, extension);
    const targetPath = join(this.recordsDir, fileName);
    const serialized = isJson ? JSON.stringify(value, null, 2) : String(value ?? '');

    await writeFile(targetPath, serialized);
    const stats = await stat(targetPath);

    const now = nowIso();
    const nextRecord = {
      key,
      fileName,
      contentType,
      bytes: stats.size,
      updatedAt: now,
    };

    this.manifest.records = toArray(this.manifest.records).filter((item) => item.key !== key);
    this.manifest.records.unshift(nextRecord);
    this.manifest.updatedAt = now;
    await writeJson(this.manifestPath, this.manifest);
    await this.updateIndex();

    return nextRecord;
  }

  getInfo() {
    if (!this.manifest && this.initPromise) {
      return this.initPromise.then(() => this.getInfo());
    }

    if (!this.manifest) {
      return null;
    }

    return {
      id: this.manifest.id,
      createdAt: this.manifest.createdAt,
      updatedAt: this.manifest.updatedAt,
      metadata: this.manifest.metadata,
      recordCount: toArray(this.manifest.records).length,
      records: toArray(this.manifest.records),
    };
  }

  listRecords() {
    if (!this.manifest && this.initPromise) {
      return this.initPromise.then(() => this.listRecords());
    }

    return toArray(this.manifest.records);
  }

  async getRecord(key) {
    await this.init();
    const record = toArray(this.manifest.records).find((item) => item.key === key);
    if (!record) {
      return undefined;
    }

    const targetPath = join(this.recordsDir, record.fileName);
    const raw = await readFile(targetPath, 'utf8');

    return {
      ...record,
      value: record.contentType === 'application/json' ? JSON.parse(raw) : raw,
    };
  }

  async setMetadata(metadata) {
    await this.init();
    this.manifest.metadata = {
      ...(this.manifest.metadata ?? {}),
      ...(metadata ?? {}),
    };
    this.manifest.updatedAt = nowIso();
    await writeJson(this.manifestPath, this.manifest);
    await this.updateIndex();
    return this.getInfo();
  }
}
