import { appendFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';
import { slugify } from '../utils/slug.js';

function nowIso() {
  return new Date().toISOString();
}

function safeDatasetDirName(datasetId) {
  return `${slugify(datasetId) || 'dataset'}-${hashText(datasetId).slice(0, 12)}`;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function createListItemsResult(items, offset, limit, total = toArray(items).length) {
  const list = [...toArray(items)];
  return {
    total,
    offset: Math.max(0, offset),
    limit: Math.max(1, limit),
    items: list,
  };
}

export class DatasetStore {
  constructor({ projectRoot = process.cwd(), datasetId, metadata = {} } = {}) {
    if (!datasetId) {
      throw new Error('datasetId is required');
    }

    this.projectRoot = projectRoot;
    this.datasetId = datasetId;
    this.metadata = metadata;
    this.storageDir = resolve(projectRoot, '.omnicrawl', 'datasets');
    this.indexPath = join(this.storageDir, 'index.json');
    this.datasetDir = join(this.storageDir, safeDatasetDirName(datasetId));
    this.manifestPath = join(this.datasetDir, 'manifest.json');
    this.itemsPath = join(this.datasetDir, 'items.ndjson');
    this.manifest = null;
    this.initPromise = null;
    this.persistChain = Promise.resolve();
  }

  static async list({ projectRoot = process.cwd(), limit = 100 } = {}) {
    const storageDir = resolve(projectRoot, '.omnicrawl', 'datasets');
    const indexPath = join(storageDir, 'index.json');

    try {
      return toArray(await readJson(indexPath))
        .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  static async get({ projectRoot = process.cwd(), datasetId } = {}) {
    const storageDir = resolve(projectRoot, '.omnicrawl', 'datasets');
    const manifestPath = join(storageDir, safeDatasetDirName(datasetId), 'manifest.json');

    try {
      return await readJson(manifestPath);
    } catch {
      return null;
    }
  }

  static async listItems({ projectRoot = process.cwd(), datasetId, offset = 0, limit = 50, query = '' } = {}) {
    const storageDir = resolve(projectRoot, '.omnicrawl', 'datasets');
    const itemsPath = join(storageDir, safeDatasetDirName(datasetId), 'items.ndjson');

    try {
      const raw = await readFile(itemsPath, 'utf8');
      const items = (raw.trim() ? raw.trim().split('\n') : []).map((line) => JSON.parse(line));
      const filtered = query
        ? items.filter((item) => JSON.stringify(item).toLowerCase().includes(String(query).toLowerCase()))
        : items;
      const safeOffset = Math.max(0, offset);
      const safeLimit = Math.max(1, limit);

      return createListItemsResult(
        filtered.slice(safeOffset, safeOffset + safeLimit),
        safeOffset,
        safeLimit,
        filtered.length,
      );
    } catch {
      return createListItemsResult([], Math.max(0, offset), Math.max(1, limit));
    }
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        await ensureDir(this.datasetDir);

        try {
          this.manifest = await readJson(this.manifestPath);
        } catch {
          const now = nowIso();
          this.manifest = {
            id: this.datasetId,
            createdAt: now,
            updatedAt: now,
            itemCount: 0,
            metadata: this.metadata,
          };
          await writeJson(this.manifestPath, this.manifest);
          await this.updateIndex();
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  schedulePersist(task) {
    this.persistChain = this.persistChain.catch(() => {}).then(task);
    return this.persistChain;
  }

  async updateIndex() {
    const current = toArray(await readJson(this.indexPath).catch(() => []));
    const next = current.filter((item) => item.id !== this.datasetId);
    next.unshift(this.manifest);
    await writeJson(this.indexPath, next);
  }

  async addItem(item) {
    await this.init();
    await this.schedulePersist(async () => {
      await appendFile(this.itemsPath, `${JSON.stringify(item)}\n`);
      this.manifest.itemCount += 1;
      this.manifest.updatedAt = nowIso();
      await writeJson(this.manifestPath, this.manifest);
      await this.updateIndex();
    });

    return this.manifest.itemCount;
  }

  getInfo() {
    if (!this.manifest && this.initPromise) {
      return this.initPromise.then(() => ({ ...this.manifest }));
    }

    if (!this.manifest) {
      return null;
    }

    return {
      ...this.manifest,
    };
  }

  async listItems({ offset = 0, limit = 50, query = '' } = {}) {
    await this.init();
    return DatasetStore.listItems({
      projectRoot: this.projectRoot,
      datasetId: this.datasetId,
      offset,
      limit,
      query,
    });
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
    return this.manifest;
  }
}
