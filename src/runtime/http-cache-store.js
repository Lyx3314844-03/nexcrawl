import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';
import { slugify } from '../utils/slug.js';
import { buildRequestUniqueKey } from './request-queue.js';

function nowIso() {
  return new Date().toISOString();
}

function safeStoreDirName(storeId) {
  return `${slugify(storeId) || 'http-cache'}-${hashText(storeId).slice(0, 12)}`;
}

function safeEntryBaseName(cacheKey) {
  return `${hashText(cacheKey).slice(0, 16)}-${slugify(cacheKey).slice(0, 48) || 'entry'}`;
}

function extensionFromContentType(contentType) {
  if (!contentType) {
    return '.txt';
  }

  const normalized = String(contentType).toLowerCase();
  if (normalized.includes('html')) {
    return '.html';
  }
  if (normalized.includes('json')) {
    return '.json';
  }
  if (normalized.includes('xml')) {
    return '.xml';
  }
  if (normalized.includes('javascript')) {
    return '.js';
  }

  return '.txt';
}

function toBodyText(response) {
  if (typeof response?.body === 'string') {
    return response.body;
  }

  return String(response?.body ?? '');
}

function sanitizeExtracted(extracted = {}) {
  if (!extracted || typeof extracted !== 'object' || Array.isArray(extracted)) {
    return {};
  }

  const next = {};
  for (const [key, value] of Object.entries(extracted)) {
    if (key === '_meta') {
      continue;
    }
    next[key] = value;
  }
  return next;
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function joinChangePath(basePath, nextPart) {
  if (!basePath) {
    return typeof nextPart === 'number' ? `[${nextPart}]` : String(nextPart);
  }

  return typeof nextPart === 'number'
    ? `${basePath}[${nextPart}]`
    : `${basePath}.${nextPart}`;
}

function pushFieldChange(changes, path, kind, previous, current) {
  changes.push({
    field: String(path).split(/[.[\]]/).filter(Boolean)[0] ?? String(path),
    path,
    kind,
    previous: previous ?? null,
    current: current ?? null,
  });
}

function compareExtractedAtPath(previousValue, currentValue, path, changes) {
  const previousJson = stableJson(previousValue);
  const currentJson = stableJson(currentValue);
  if (previousJson === currentJson) {
    return;
  }

  if (Array.isArray(previousValue) && Array.isArray(currentValue)) {
    const length = Math.max(previousValue.length, currentValue.length);
    for (let index = 0; index < length; index += 1) {
      const hasPrevious = index < previousValue.length;
      const hasCurrent = index < currentValue.length;
      const nextPath = joinChangePath(path, index);

      if (!hasPrevious && hasCurrent) {
        pushFieldChange(changes, nextPath, 'added', null, currentValue[index]);
        continue;
      }

      if (hasPrevious && !hasCurrent) {
        pushFieldChange(changes, nextPath, 'removed', previousValue[index], null);
        continue;
      }

      compareExtractedAtPath(previousValue[index], currentValue[index], nextPath, changes);
    }
    return;
  }

  if (isPlainObject(previousValue) && isPlainObject(currentValue)) {
    const fieldNames = new Set([
      ...Object.keys(previousValue),
      ...Object.keys(currentValue),
    ]);

    for (const field of [...fieldNames].sort((left, right) => left.localeCompare(right))) {
      const hasPrevious = Object.prototype.hasOwnProperty.call(previousValue, field);
      const hasCurrent = Object.prototype.hasOwnProperty.call(currentValue, field);
      const nextPath = joinChangePath(path, field);

      if (!hasPrevious && hasCurrent) {
        pushFieldChange(changes, nextPath, 'added', null, currentValue[field]);
        continue;
      }

      if (hasPrevious && !hasCurrent) {
        pushFieldChange(changes, nextPath, 'removed', previousValue[field], null);
        continue;
      }

      compareExtractedAtPath(previousValue[field], currentValue[field], nextPath, changes);
    }
    return;
  }

  pushFieldChange(changes, path, 'updated', previousValue, currentValue);
}

function compareExtractedFields(previousExtracted = {}, currentExtracted = {}) {
  const changes = [];
  compareExtractedAtPath(previousExtracted, currentExtracted, '', changes);
  return changes;
}

export class HttpCacheStore {
  constructor({
    projectRoot = process.cwd(),
    workflow,
    logger = null,
    dataPlane = null,
  } = {}) {
    this.projectRoot = projectRoot;
    this.workflow = workflow ?? {};
    this.logger = logger;
    this.dataPlane = dataPlane;
    this.config = {
      enabled: this.workflow.httpCache?.enabled === true,
      storeId: this.workflow.httpCache?.storeId ?? `http-cache:${this.workflow.name ?? 'default'}`,
      shared: this.workflow.httpCache?.shared !== false,
      persistBody: this.workflow.httpCache?.persistBody !== false,
      reuseBodyOnNotModified: this.workflow.httpCache?.reuseBodyOnNotModified !== false,
      maxBodyBytes: Number(this.workflow.httpCache?.maxBodyBytes ?? 1_000_000),
      requestQueue: this.workflow.requestQueue ?? {},
    };
    this.storageDir = resolve(projectRoot, '.omnicrawl', 'http-cache', safeStoreDirName(this.config.storeId));
    this.indexPath = join(this.storageDir, 'index.json');
    this.entriesDir = join(this.storageDir, 'entries');
    this.bodiesDir = join(this.storageDir, 'bodies');
    this.index = {
      storeId: this.config.storeId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      entries: {},
    };
    this.initPromise = null;
    this.stats = {
      enabled: this.config.enabled,
      storeId: this.config.storeId,
      entryCount: 0,
      firstSeenCount: 0,
      changedCount: 0,
      unchangedCount: 0,
      extractedTrackedCount: 0,
      extractedFirstSeenCount: 0,
      extractedChangedCount: 0,
      extractedUnchangedCount: 0,
      fieldChangeCount: 0,
      conditionalRequests: 0,
      validatorsApplied: 0,
      notModifiedCount: 0,
      bodyReuseCount: 0,
      storesWritten: 0,
      bodyBytesWritten: 0,
      bodyWriteSkippedCount: 0,
      misses: 0,
    };
  }

  isEnabled() {
    return this.config.enabled;
  }

  usesSharedStore() {
    return this.isEnabled() && this.config.shared !== false && Boolean(this.dataPlane);
  }

  sharedStoreId() {
    return `http-cache:${this.config.storeId}`;
  }

  entryRecordKey(cacheKey) {
    return `entry:${hashText(cacheKey)}`;
  }

  bodyRecordKey(cacheKey) {
    return `body:${hashText(cacheKey)}`;
  }

  snapshot() {
    return {
      ...this.stats,
      updatedAt: this.index.updatedAt,
    };
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.isEnabled()) {
          return this;
        }

        if (this.usesSharedStore()) {
          await this.dataPlane.init();
          this.dataPlane.ensureKeyValueStore(this.sharedStoreId(), {
            kind: 'http-cache',
            storeId: this.config.storeId,
            shared: true,
          });
          const sharedStore = this.dataPlane.getKeyValueStore(this.sharedStoreId());
          const entryCount = (sharedStore?.records ?? []).filter((record) => String(record.key).startsWith('entry:')).length;
          this.stats.entryCount = entryCount;
          return this;
        }

        await ensureDir(this.storageDir);
        await ensureDir(this.entriesDir);
        await ensureDir(this.bodiesDir);

        try {
          this.index = await readJson(this.indexPath);
        } catch {
          this.index = {
            storeId: this.config.storeId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
            entries: {},
          };
          await this.persistIndex();
        }

        this.stats.entryCount = Object.keys(this.index.entries ?? {}).length;
        return this;
      })();
    }

    await this.initPromise;
    return this;
  }

  async persistIndex() {
    if (this.usesSharedStore()) {
      return;
    }
    this.index.updatedAt = nowIso();
    await writeJson(this.indexPath, this.index);
  }

  createCacheKey(request) {
    return buildRequestUniqueKey({
      url: request.url,
      method: request.method ?? 'GET',
      body: request.body,
    }, this.config.requestQueue);
  }

  async getEntry(request) {
    const cacheKey = this.createCacheKey(request);
    return {
      cacheKey,
      entry: await this.getEntryByCacheKey(cacheKey),
    };
  }

  async getEntryByCacheKey(cacheKey) {
    if (this.usesSharedStore()) {
      const record = this.dataPlane.getRecord(this.sharedStoreId(), this.entryRecordKey(cacheKey));
      return record?.value ?? null;
    }

    return this.index.entries?.[cacheKey] ?? null;
  }

  async writeEntry(cacheKey, entry, { isNew = false } = {}) {
    if (this.usesSharedStore()) {
      this.dataPlane.setRecord(this.sharedStoreId(), this.entryRecordKey(cacheKey), entry, {
        contentType: 'application/json',
        fileName: `${safeEntryBaseName(cacheKey)}.json`,
      });
      if (isNew) {
        this.stats.entryCount += 1;
      }
      return;
    }

    this.index.entries[cacheKey] = entry;
    if (isNew) {
      this.stats.entryCount = Object.keys(this.index.entries).length;
    }
    await writeJson(join(this.entriesDir, `${safeEntryBaseName(cacheKey)}.json`), entry);
    await this.persistIndex();
  }

  async readBody(cacheKey, bodyFileName) {
    if (this.usesSharedStore()) {
      const record = this.dataPlane.getRecord(this.sharedStoreId(), this.bodyRecordKey(cacheKey));
      return typeof record?.value === 'string' ? record.value : null;
    }

    if (!bodyFileName) {
      return null;
    }

    return readFile(join(this.bodiesDir, bodyFileName), 'utf8');
  }

  async writeBody(cacheKey, bodyFileName, body, contentType) {
    if (this.usesSharedStore()) {
      this.dataPlane.setRecord(this.sharedStoreId(), this.bodyRecordKey(cacheKey), body, {
        contentType,
        fileName: bodyFileName,
      });
      return;
    }

    await writeFile(join(this.bodiesDir, bodyFileName), body);
  }

  async prepareRequest(request) {
    if (!this.isEnabled()) {
      return null;
    }

    await this.init();
    if (String(request.method ?? 'GET').toUpperCase() !== 'GET') {
      return null;
    }

    const { cacheKey, entry } = await this.getEntry(request);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }

    request.headers = request.headers ?? {};
    let applied = false;

    if (entry.etag && !request.headers['if-none-match'] && !request.headers['If-None-Match']) {
      request.headers['if-none-match'] = entry.etag;
      applied = true;
    }

    if (entry.lastModified && !request.headers['if-modified-since'] && !request.headers['If-Modified-Since']) {
      request.headers['if-modified-since'] = entry.lastModified;
      applied = true;
    }

    if (applied) {
      this.stats.conditionalRequests += 1;
      this.stats.validatorsApplied += 1;
    }

    return {
      cacheKey,
      entry,
      applied,
    };
  }

  async resolveResponse(request, response) {
    if (!this.isEnabled()) {
      return response;
    }

    await this.init();
    const { cacheKey, entry } = await this.getEntry(request);
    if (!entry || response.status !== 304) {
      return response;
    }

    this.stats.notModifiedCount += 1;
    entry.lastValidatedAt = nowIso();
    await this.writeEntry(cacheKey, entry);

    if (!this.config.reuseBodyOnNotModified || !entry.bodyFileName) {
      this.stats.unchangedCount += 1;
      return {
        ...response,
        notModified: true,
        cacheReused: false,
        contentState: 'unchanged',
        cacheKey,
      };
    }

    try {
      const body = await this.readBody(cacheKey, entry.bodyFileName);
      this.stats.bodyReuseCount += 1;

      return {
        ...response,
        body,
        headers: {
          ...response.headers,
          ...(entry.contentType && !response.headers?.['content-type'] ? { 'content-type': entry.contentType } : {}),
        },
        finalUrl: response.finalUrl ?? entry.finalUrl ?? request.url,
        notModified: true,
        cacheReused: true,
        contentState: 'unchanged',
        cacheKey,
        cacheEntry: {
          etag: entry.etag ?? null,
          lastModified: entry.lastModified ?? null,
          storedAt: entry.storedAt ?? null,
        },
      };
    } catch (error) {
      this.logger?.warn?.('http cache body reuse failed', {
        url: request.url,
        cacheKey,
        error: error?.message ?? String(error),
      });
      return {
        ...response,
        notModified: true,
        cacheReused: false,
        contentState: 'unchanged',
        cacheKey,
      };
    }
  }

  async storeResponse(request, response) {
    if (!this.isEnabled()) {
      return null;
    }

    await this.init();
    if (String(request.method ?? 'GET').toUpperCase() !== 'GET') {
      return null;
    }
    if (response.status >= 400 || response.status === 304) {
      return null;
    }

    const cacheKey = this.createCacheKey(request);
    const previousEntry = await this.getEntryByCacheKey(cacheKey);
    const body = toBodyText(response);
    const bodyBytes = Buffer.byteLength(body);
    const bodyHash = hashText(body);
    const contentType = response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? 'text/plain; charset=utf-8';
    const baseName = safeEntryBaseName(cacheKey);
    let bodyFileName = previousEntry?.bodyFileName ?? null;

    if (this.config.persistBody && bodyBytes <= this.config.maxBodyBytes) {
      bodyFileName = `${baseName}${extensionFromContentType(contentType)}`;
      await this.writeBody(cacheKey, bodyFileName, body, contentType);
      this.stats.bodyBytesWritten += bodyBytes;
    } else if (bodyBytes > this.config.maxBodyBytes) {
      this.stats.bodyWriteSkippedCount += 1;
    }

    const contentState =
      !previousEntry
        ? 'first-seen'
        : previousEntry.bodyHash === bodyHash
          ? 'unchanged'
          : 'changed';

    if (contentState === 'first-seen') {
      this.stats.firstSeenCount += 1;
    } else if (contentState === 'unchanged') {
      this.stats.unchangedCount += 1;
    } else if (contentState === 'changed') {
      this.stats.changedCount += 1;
    }

    const nextEntry = {
      cacheKey,
      url: request.url,
      finalUrl: response.finalUrl ?? request.url,
      status: response.status,
      etag: response.headers?.etag ?? response.headers?.ETag ?? null,
      lastModified: response.headers?.['last-modified'] ?? response.headers?.['Last-Modified'] ?? null,
      contentType,
      storedAt: nowIso(),
      fetchedAt: response.fetchedAt ?? nowIso(),
      bodyFileName,
      bodyBytes,
      bodyHash,
      contentState,
      previousStoredAt: previousEntry?.storedAt ?? null,
      extracted: previousEntry?.extracted ?? null,
      extractedHash: previousEntry?.extractedHash ?? null,
      extractedAt: previousEntry?.extractedAt ?? null,
      extractedChangeState: previousEntry?.extractedChangeState ?? null,
      fieldChangeCount: previousEntry?.fieldChangeCount ?? 0,
      changedFields: previousEntry?.changedFields ?? [],
    };

    const isNew = !previousEntry;
    this.stats.storesWritten += 1;
    await this.writeEntry(cacheKey, nextEntry, { isNew });

    return nextEntry;
  }

  async recordExtraction(request, result) {
    if (!this.isEnabled()) {
      return null;
    }

    await this.init();
    if (String(request.method ?? 'GET').toUpperCase() !== 'GET') {
      return null;
    }

    const cacheKey = this.createCacheKey(request);
    const entry = await this.getEntryByCacheKey(cacheKey);
    if (!entry) {
      return null;
    }

    const extracted = sanitizeExtracted(result?.extracted ?? {});
    const extractedHash = hashText(stableJson(extracted));
    const previousExtracted = entry.extracted ?? null;
    const fieldChanges = previousExtracted ? compareExtractedFields(previousExtracted, extracted) : [];
    const extractedChangeState =
      !previousExtracted
        ? 'first-seen'
        : fieldChanges.length === 0
          ? 'unchanged'
          : 'changed';

    this.stats.extractedTrackedCount += 1;
    if (extractedChangeState === 'first-seen') {
      this.stats.extractedFirstSeenCount += 1;
    } else if (extractedChangeState === 'unchanged') {
      this.stats.extractedUnchangedCount += 1;
    } else if (extractedChangeState === 'changed') {
      this.stats.extractedChangedCount += 1;
      this.stats.fieldChangeCount += fieldChanges.length;
    }

    const nextEntry = {
      ...entry,
      extracted,
      extractedHash,
      extractedAt: nowIso(),
      extractedChangeState,
      fieldChangeCount: fieldChanges.length,
      changedFields: fieldChanges.map((entry) => entry.field),
    };

    await this.writeEntry(cacheKey, nextEntry);

    return {
      cacheKey,
      extractedChangeState,
      fieldChanges,
      previousExtractedAt: entry.extractedAt ?? null,
      changedFields: fieldChanges.map((entry) => entry.field),
    };
  }
}
