import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { appendNdjson, ensureDir, writeJson } from '../utils/fs.js';
import { slugify } from '../utils/slug.js';
import { resolveBrowserDebugConfig } from '../fetchers/browser-debugger.js';

function extensionFromContentType(contentType) {
  if (!contentType) {
    return '.txt';
  }

  if (contentType.includes('html')) {
    return '.html';
  }

  if (contentType.includes('json')) {
    return '.json';
  }

  if (contentType.includes('xml')) {
    return '.xml';
  }

  return '.txt';
}

function attachmentFileName(attachment = {}, fallbackName = 'artifact.bin') {
  const provided = String(attachment.fileName ?? '').trim();
  if (provided) {
    return provided;
  }

  return fallbackName;
}

export class SinkManager {
  constructor({
    runDir,
    output,
    browserDebug,
    datasetStore = null,
    keyValueStore = null,
    dataPlane = null,
    jobId = null,
    localArtifactsEnabled = true,
  }) {
    this.runDir = runDir;
    this.output = output;
    this.resultsPath = join(runDir, 'results.ndjson');
    this.browserDebug = resolveBrowserDebugConfig({
      debug: browserDebug ?? {},
    });
    this.datasetStore = datasetStore;
    this.keyValueStore = keyValueStore;
    this.dataPlane = dataPlane;
    this.jobId = jobId;
    this.localArtifactsEnabled = localArtifactsEnabled;
  }

  async init() {
    if (this.localArtifactsEnabled) {
      await ensureDir(this.runDir);
    }
    if (this.datasetStore) {
      await this.datasetStore.init();
    }
    if (this.keyValueStore) {
      await this.keyValueStore.init();
    }
    if (this.output.persistBodies && this.localArtifactsEnabled) {
      await ensureDir(join(this.runDir, 'pages'));
    }

    if (this.browserDebug.enabled && this.browserDebug.persistArtifacts && this.localArtifactsEnabled) {
      await ensureDir(join(this.runDir, 'debug'));
    }
  }

  async persistArtifact(relativePath, body, contentType = 'text/plain; charset=utf-8') {
    if (this.localArtifactsEnabled) {
      const absolutePath = join(this.runDir, relativePath);
      await ensureDir(dirname(absolutePath));
      await writeFile(absolutePath, body);
    }

    if (this.dataPlane && this.jobId) {
      this.dataPlane.writeArtifact(this.jobId, relativePath.replaceAll('\\', '/'), body, { contentType });
    }
  }

  async persistJsonArtifact(relativePath, value) {
    const serialized = JSON.stringify(value, null, 2);
    await this.persistArtifact(relativePath, serialized, 'application/json');
  }

  compactTextPayload(payload) {
    if (!payload || typeof payload !== 'object' || typeof payload.text !== 'string') {
      return payload ?? null;
    }

    const text = payload.text;
    const bytes = Buffer.byteLength(text);
    const previewBytes = this.browserDebug.previewBytes;
    const previewText = bytes > previewBytes ? Buffer.from(text).subarray(0, previewBytes).toString('utf8') : text;

    return {
      ...payload,
      text: previewText,
      previewTruncated: bytes > previewBytes || payload.truncated === true,
    };
  }

  compactDebugPayload(debug, artifactPath, artifactBytes) {
    const previewItems = this.browserDebug.previewItems;
    const previewBytes = this.browserDebug.previewBytes;

    const previewText = (value) => {
      const text = typeof value === 'string' ? value : String(value ?? '');
      const bytes = Buffer.byteLength(text);
      return {
        text: bytes > previewBytes ? Buffer.from(text).subarray(0, previewBytes).toString('utf8') : text,
        truncated: bytes > previewBytes,
      };
    };

    return {
      enabled: debug.enabled,
      finalUrl: debug.finalUrl ?? null,
      captureSupport: debug.captureSupport ?? null,
      summary: debug.summary ?? {},
      identity: debug.identity ?? null,
      preview: {
        items: previewItems,
        bytes: previewBytes,
      },
      artifact: this.browserDebug.persistArtifacts
        ? {
            path: artifactPath,
            format: 'browser-debug-v2',
            bytes: artifactBytes,
          }
        : null,
      requests: (debug.requests ?? []).slice(0, previewItems).map((item) => ({
        ...item,
        requestBody: this.compactTextPayload(item.requestBody),
        responseBody: this.compactTextPayload(item.responseBody),
      })),
      scripts: (debug.scripts ?? []).slice(0, previewItems).map((item) => {
        const { _client, ...safeItem } = item;
        const preview = previewText(item.source);
        return {
          ...safeItem,
          sourcePreview: preview.text,
          sourcePreviewTruncated: preview.truncated || item.truncated === true,
          source: undefined,
        };
      }),
      sourceMaps: (debug.sourceMaps ?? []).slice(0, previewItems).map((item) => {
        const preview = previewText(item.content);
        return {
          ...item,
          contentPreview: preview.text,
          contentPreviewTruncated: preview.truncated || item.truncated === true,
          content: undefined,
        };
      }),
      hooks: {
        ...(debug.hooks ?? {}),
        events: (debug.hooks?.events ?? []).slice(0, previewItems),
      },
      attachments: debug.attachments ?? null,
    };
  }

  chunkItems(items, size = 50) {
    const chunks = [];

    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }

    return chunks;
  }

  async writeChunkedNdjson(baseDir, prefix, items, chunkSize = 50) {
    const relativePaths = [];
    const chunks = this.chunkItems(items, chunkSize);

    for (let index = 0; index < chunks.length; index += 1) {
      const fileName = `${prefix}-${String(index + 1).padStart(4, '0')}.ndjson`;
      const payload = chunks[index].map((entry) => JSON.stringify(entry)).join('\n');
      await this.persistArtifact(join(baseDir, fileName), payload ? `${payload}\n` : '', 'application/x-ndjson');
      relativePaths.push(fileName);
    }

    return relativePaths;
  }

  async persistShardedDebugArtifacts(result) {
    const artifactBaseName = `${String(result.sequence).padStart(4, '0')}-${slugify(result.url)}.browser-debug`;
    const artifactDir = join('debug', artifactBaseName);
    const scriptsDir = join(artifactDir, 'scripts');
    const sourceMapsDir = join(artifactDir, 'source-maps');

    if (this.localArtifactsEnabled) {
      await ensureDir(join(this.runDir, artifactDir));
      await ensureDir(join(this.runDir, scriptsDir));
      await ensureDir(join(this.runDir, sourceMapsDir));
    }

    let totalBytes = 0;

    const scriptIndexItems = [];
    for (let index = 0; index < (result.debug?.scripts ?? []).length; index += 1) {
      const item = result.debug.scripts[index];
      const { _client, ...safeItem } = item;
      const extension = item.kind === 'inline' ? '.inline.js' : '.js';
      const fileName = `${String(index + 1).padStart(4, '0')}-${item.hash.slice(0, 12)}${extension}`;
      await this.persistArtifact(join(scriptsDir, fileName), item.source ?? '', 'application/javascript');
      totalBytes += Buffer.byteLength(item.source ?? '');
      scriptIndexItems.push({
        ...safeItem,
        source: undefined,
        contentPath: `scripts/${fileName}`,
      });
    }

    const sourceMapIndexItems = [];
    for (let index = 0; index < (result.debug?.sourceMaps ?? []).length; index += 1) {
      const item = result.debug.sourceMaps[index];
      const extension = item.contentType?.includes('json') ? '.json' : '.map';
      const fileName = `${String(index + 1).padStart(4, '0')}-${(item.hash ?? 'map').slice(0, 12)}${extension}`;
      await this.persistArtifact(join(sourceMapsDir, fileName), item.content ?? '', item.contentType ?? 'application/json');
      totalBytes += Buffer.byteLength(item.content ?? '');
      sourceMapIndexItems.push({
        ...item,
        content: undefined,
        contentPath: `source-maps/${fileName}`,
      });
    }

    const requestFiles = await this.writeChunkedNdjson(artifactDir, 'requests', result.debug?.requests ?? []);
    const hookFiles = await this.writeChunkedNdjson(artifactDir, 'hooks', result.debug?.hooks?.events ?? []);
    const scriptIndexFiles = await this.writeChunkedNdjson(artifactDir, 'scripts-index', scriptIndexItems);
    const sourceMapIndexFiles = await this.writeChunkedNdjson(artifactDir, 'source-maps-index', sourceMapIndexItems);

    for (const collection of [result.debug?.requests ?? [], result.debug?.hooks?.events ?? [], scriptIndexItems, sourceMapIndexItems]) {
      totalBytes += Buffer.byteLength(JSON.stringify(collection));
    }

    const persistedAttachments = {};
    for (const [name, attachment] of Object.entries(result.debug?.attachments ?? {})) {
      if (!attachment) {
        persistedAttachments[name] = null;
        continue;
      }

      const { contentBase64, ...metadata } = attachment;
      if (typeof contentBase64 !== 'string' || contentBase64.length === 0) {
        persistedAttachments[name] = metadata;
        continue;
      }

      const fileName = attachmentFileName(attachment, `${name}.bin`);
      const relativePath = join(artifactDir, fileName);
      const buffer = Buffer.from(contentBase64, 'base64');
      await this.persistArtifact(relativePath, buffer, attachment.contentType ?? 'application/octet-stream');
      totalBytes += buffer.length;
      persistedAttachments[name] = {
        ...metadata,
        path: `debug/${artifactBaseName}/${fileName}`.replaceAll('\\', '/'),
      };
    }

    const manifest = {
      format: 'browser-debug-v2',
      finalUrl: result.debug?.finalUrl ?? null,
      captureSupport: result.debug?.captureSupport ?? null,
      identity: result.debug?.identity ?? null,
      summary: result.debug?.summary ?? {},
      attachments: persistedAttachments,
      files: {
        requests: requestFiles,
        hooks: hookFiles,
        scriptsIndex: scriptIndexFiles,
        sourceMapsIndex: sourceMapIndexFiles,
      },
    };

    const manifestName = 'manifest.json';
    await this.persistJsonArtifact(join(artifactDir, manifestName), manifest);
    totalBytes += Buffer.byteLength(JSON.stringify(manifest));
    return this.compactDebugPayload({
      ...result.debug,
      attachments: persistedAttachments,
    }, `debug/${artifactBaseName}/${manifestName}`, totalBytes);
  }

  async persistDebugArtifacts(result) {
    if (!result.debug?.enabled) {
      return result.debug ?? null;
    }

    if (!this.browserDebug.persistArtifacts) {
      return result.debug;
    }

    return this.persistShardedDebugArtifacts(result);
  }

  async write({ result, response }) {
    const persistedResult = structuredClone(result);
    persistedResult.debug = await this.persistDebugArtifacts(result);

    if (this.dataPlane && this.jobId) {
      this.dataPlane.appendResult(this.jobId, persistedResult);
    } else {
      await appendNdjson(this.resultsPath, persistedResult);
    }
    if (this.datasetStore) {
      await this.datasetStore.addItem(persistedResult);
    }

    if (this.output.console) {
      process.stdout.write(`[${result.status}] ${result.url} (${result.mode})\n`);
    }

    if (!this.output.persistBodies) {
      return;
    }

    const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
    const filePath = join(
      'pages',
      `${String(result.sequence).padStart(4, '0')}-${slugify(result.url)}${extensionFromContentType(contentType)}`,
    );

    await this.persistArtifact(filePath, response.body, contentType || 'text/plain; charset=utf-8');
  }

  async writeSummary(summary) {
    if (this.localArtifactsEnabled) {
      await writeJson(join(this.runDir, 'summary.json'), summary);
    }
    if (this.dataPlane && this.jobId) {
      this.dataPlane.writeJsonArtifact(this.jobId, 'summary.json', summary);
    }
    if (this.keyValueStore) {
      await this.keyValueStore.setRecord('SUMMARY', summary);
    }
  }
}
