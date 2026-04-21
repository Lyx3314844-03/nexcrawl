import { join, resolve } from 'node:path';
import { hashText } from '../utils/hash.js';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { slugify } from '../utils/slug.js';

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function stringify(value) {
  return JSON.stringify(value ?? null, null, 2);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export class ReverseAssetStore {
  constructor({
    projectRoot = process.cwd(),
    storageDir = '.omnicrawl/reverse-assets',
    workflowName = null,
    jobId = null,
    dataPlane = null,
  } = {}) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, storageDir);
    this.workflowName = workflowName;
    this.jobId = jobId;
    this.dataPlane = dataPlane;
    this.indexPath = join(this.storageDir, 'index.json');
    this.index = {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      signers: [],
      regressions: [],
      appCaptures: [],
      aiSurfaces: [],
    };
    this.initPromise = null;
  }

  normalizeIndex(index = {}) {
    return {
      createdAt: index.createdAt ?? nowIso(),
      updatedAt: index.updatedAt ?? nowIso(),
      signers: toArray(index.signers),
      regressions: toArray(index.regressions),
      appCaptures: toArray(index.appCaptures),
      aiSurfaces: toArray(index.aiSurfaces),
    };
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        try {
          this.index = this.normalizeIndex(await readJson(this.indexPath));
        } catch {
          await this.persistIndex();
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async persistIndex() {
    this.index.updatedAt = nowIso();
    await writeJson(this.indexPath, this.index);
  }

  buildCollectionDir(collection, assetId) {
    const safeId = slugify(assetId) || hashText(assetId).slice(0, 12);
    return join(this.storageDir, collection, safeId);
  }

  async writeVersionedAsset(collection, assetId, payload) {
    await this.init();
    const versionId = hashText(stringify(payload));
    const dir = this.buildCollectionDir(collection, assetId);
    const versionsDir = join(dir, 'versions');
    const latestPath = join(dir, 'latest.json');
    const versionPath = join(versionsDir, `${versionId}.json`);
    await ensureDir(versionsDir);

    const document = {
      assetId,
      versionId,
      workflowName: this.workflowName,
      jobId: this.jobId,
      createdAt: nowIso(),
      payload: clone(payload),
    };

    await Promise.all([
      writeJson(versionPath, document),
      writeJson(latestPath, document),
    ]);

    if (this.dataPlane && this.jobId) {
      this.dataPlane.writeJsonArtifact(this.jobId, `reverse-assets/${collection}/${assetId}/latest.json`, document);
    }

    return {
      assetId,
      versionId,
      path: latestPath,
      payload: document.payload,
    };
  }

  async readLatestAsset(collection, assetId) {
    await this.init();
    try {
      const dir = this.buildCollectionDir(collection, assetId);
      return await readJson(join(dir, 'latest.json'));
    } catch {
      return null;
    }
  }

  async recordSignerArtifact(assetId, payload) {
    const record = await this.writeVersionedAsset('signers', assetId, payload);
    const existing = this.index.signers.find((entry) => entry.assetId === assetId);
    const next = {
      assetId,
      versionId: record.versionId,
      workflowName: this.workflowName,
      jobId: this.jobId,
      updatedAt: nowIso(),
      source: payload?.source ?? null,
      functionName: payload?.selectedCandidate?.name ?? payload?.functionName ?? null,
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      this.index.signers.push(next);
    }
    await this.persistIndex();
    return record;
  }

  async getSignerArtifact(assetId) {
    return this.readLatestAsset('signers', assetId);
  }

  async recordRegressionReport(assetId, payload) {
    const record = await this.writeVersionedAsset('regressions', assetId, payload);
    const existing = this.index.regressions.find((entry) => entry.assetId === assetId);
    const next = {
      assetId,
      versionId: record.versionId,
      workflowName: this.workflowName,
      jobId: this.jobId,
      updatedAt: nowIso(),
      passed: payload?.passed === true,
      suiteCount: toArray(payload?.suites).length,
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      this.index.regressions.push(next);
    }
    await this.persistIndex();
    return record;
  }

  async recordAppCapture(assetId, payload) {
    const record = await this.writeVersionedAsset('app-captures', assetId, payload);
    const existing = this.index.appCaptures.find((entry) => entry.assetId === assetId);
    const next = {
      assetId,
      versionId: record.versionId,
      workflowName: this.workflowName,
      jobId: this.jobId,
      updatedAt: nowIso(),
      platform: payload?.platform ?? null,
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      this.index.appCaptures.push(next);
    }
    await this.persistIndex();
    return record;
  }

  async recordAISurface(assetId, payload) {
    const record = await this.writeVersionedAsset('ai-surfaces', assetId, payload);
    const existing = this.index.aiSurfaces.find((entry) => entry.assetId === assetId);
    const next = {
      assetId,
      versionId: record.versionId,
      workflowName: this.workflowName,
      jobId: this.jobId,
      updatedAt: nowIso(),
      target: payload?.target ?? null,
      classification: payload?.protection?.classification ?? null,
    };
    if (existing) {
      Object.assign(existing, next);
    } else {
      this.index.aiSurfaces.push(next);
    }
    await this.persistIndex();
    return record;
  }

  snapshot() {
    return clone(this.index);
  }
}
