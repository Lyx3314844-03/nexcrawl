import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { ensureDir, appendNdjson } from '../utils/fs.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { sanitizeFilename } from '../utils/validation.js';

const MIME_EXTENSION_MAP = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
  ['image/svg+xml', '.svg'],
  ['image/bmp', '.bmp'],
  ['image/x-icon', '.ico'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
  ['video/quicktime', '.mov'],
  ['video/x-matroska', '.mkv'],
  ['application/vnd.apple.mpegurl', '.m3u8'],
  ['application/x-mpegurl', '.m3u8'],
  ['application/dash+xml', '.mpd'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp3', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/x-m4a', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/wav', '.wav'],
  ['audio/x-wav', '.wav'],
  ['audio/flac', '.flac'],
  ['audio/ogg', '.ogg'],
  ['audio/opus', '.opus'],
  ['audio/webm', '.weba'],
]);

function normalizeAsset(asset) {
  if (typeof asset === 'string') {
    return {
      url: asset,
      kind: null,
      source: null,
      mimeType: null,
      title: null,
      pageUrl: null,
    };
  }

  if (!asset || typeof asset !== 'object' || Array.isArray(asset) || !asset.url) {
    throw new TypeError('Media asset must be a URL string or an object with a url field');
  }

  return {
    url: asset.url,
    kind: asset.kind ?? null,
    source: asset.source ?? null,
    mimeType: asset.mimeType ?? null,
    title: asset.title ?? null,
    pageUrl: asset.pageUrl ?? null,
  };
}

function normalizePatterns(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items
    .map((item) => {
      if (item instanceof RegExp) {
        return item;
      }
      const pattern = String(item ?? '').trim();
      if (!pattern) {
        return null;
      }
      try {
        return new RegExp(pattern);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeDownloadOptions(options = {}) {
  return {
    outputDir: resolve(String(options.outputDir ?? 'downloads/media')),
    organizeByKind: options.organizeByKind !== false,
    skipExisting: options.skipExisting !== false,
    timeoutMs: Math.max(1000, Number(options.timeoutMs ?? 30000) || 30000),
    concurrency: Math.max(1, Number(options.concurrency ?? 4) || 4),
    retryAttempts: Math.max(1, Number(options.retryAttempts ?? 2) || 2),
    retryBackoffMs: Math.max(0, Number(options.retryBackoffMs ?? 750) || 750),
    headers: options.headers ?? {},
    maxBytes: Number(options.maxBytes ?? 0) || 0,
    userAgent: options.userAgent ?? 'OmniCrawl-MediaDownloader/1.0',
    manifestPath: options.manifestPath ? resolve(String(options.manifestPath)) : null,
    failuresPath: options.failuresPath ? resolve(String(options.failuresPath)) : null,
    mediaInclude: normalizePatterns(options.mediaInclude),
    mediaExclude: normalizePatterns(options.mediaExclude),
    subdirTemplate: options.subdirTemplate ? String(options.subdirTemplate) : null,
    fileNameTemplate: options.fileNameTemplate ? String(options.fileNameTemplate) : null,
  };
}

function headersToObject(headers) {
  return Object.fromEntries(headers.entries());
}

function getExtensionFromMimeType(contentType) {
  const value = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSION_MAP.get(value) ?? null;
}

function getExtensionFromUrl(url) {
  try {
    const candidate = extname(new URL(url).pathname);
    return candidate ? candidate.toLowerCase() : null;
  } catch {
    return null;
  }
}

function parseContentDispositionFileName(contentDisposition) {
  const value = String(contentDisposition ?? '');
  if (!value) {
    return null;
  }

  const utfMatch = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (utfMatch) {
    try {
      return decodeURIComponent(utfMatch[1].trim().replace(/^"(.*)"$/, '$1'));
    } catch {
      return utfMatch[1].trim().replace(/^"(.*)"$/, '$1');
    }
  }

  const basicMatch = value.match(/filename\s*=\s*("?)([^";]+)\1/i);
  return basicMatch?.[2] ?? null;
}

function parseIsoDurationToSeconds(input) {
  const value = String(input ?? '').trim();
  const match = value.match(/^P(?:([0-9.]+)D)?T?(?:([0-9.]+)H)?(?:([0-9.]+)M)?(?:([0-9.]+)S)?$/i);
  if (!match) {
    return null;
  }

  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
}

function buildFallbackBaseName(asset, index) {
  const title = sanitizeFilename(String(asset.title ?? '').trim());
  if (title) {
    return title;
  }

  const kind = sanitizeFilename(String(asset.kind ?? 'media').trim() || 'media');
  const hash = createHash('sha1').update(String(asset.url)).digest('hex').slice(0, 12);
  return `${kind}-${String(index + 1).padStart(4, '0')}-${hash}`;
}

function buildTemplateContext(asset, index = 0, extension = '') {
  const assetHost = (() => {
    try {
      return new URL(asset.url).host;
    } catch {
      return '';
    }
  })();
  const pageHost = (() => {
    try {
      return asset.pageUrl ? new URL(asset.pageUrl).host : '';
    } catch {
      return '';
    }
  })();
  const hash = createHash('sha1').update(String(asset.url)).digest('hex').slice(0, 12);
  return {
    kind: sanitizeFilename(String(asset.kind ?? 'other')),
    host: sanitizeFilename(assetHost),
    pageHost: sanitizeFilename(pageHost),
    title: sanitizeFilename(String(asset.title ?? '').trim()),
    index: String(index + 1).padStart(4, '0'),
    hash,
    ext: extension.startsWith('.') ? extension.slice(1) : extension,
  };
}

function sanitizeTemplatePath(value) {
  return String(value)
    .split(/[\\/]+/)
    .map((segment) => sanitizeFilename(segment))
    .filter(Boolean)
    .join('/');
}

function sanitizeTemplateFile(value) {
  return sanitizeFilename(String(value ?? '').replace(/[\\/]+/g, '_'));
}

function renderTemplate(template, context, { kind = 'path' } = {}) {
  if (!template) {
    return null;
  }
  const rendered = String(template).replace(/\{([a-zA-Z]+)\}/g, (_match, token) => {
    return context[token] ?? '';
  }).trim();
  if (!rendered) {
    return null;
  }
  return kind === 'file' ? sanitizeTemplateFile(rendered) : sanitizeTemplatePath(rendered);
}

function buildTargetFileName({ asset, responseHeaders, index }) {
  const dispositionName = sanitizeFilename(parseContentDispositionFileName(responseHeaders['content-disposition']) ?? '');
  const dispositionExt = dispositionName ? extname(dispositionName) : '';
  if (dispositionName) {
    return dispositionExt ? dispositionName : `${dispositionName}${getExtensionFromMimeType(responseHeaders['content-type']) ?? getExtensionFromUrl(asset.url) ?? ''}`;
  }

  const pathnameName = sanitizeFilename(basename(new URL(asset.url).pathname) || '');
  const pathnameExt = pathnameName ? extname(pathnameName) : '';
  if (pathnameName && pathnameName !== '.' && pathnameName !== '..') {
    return pathnameExt ? pathnameName : `${pathnameName}${getExtensionFromMimeType(responseHeaders['content-type']) ?? ''}`;
  }

  const baseName = buildFallbackBaseName(asset, index);
  return `${baseName}${getExtensionFromMimeType(responseHeaders['content-type']) ?? getExtensionFromUrl(asset.url) ?? ''}`;
}

function buildTargetDir(asset, options) {
  const templateValue = renderTemplate(
    options.subdirTemplate,
    buildTemplateContext(asset, 0, ''),
    { kind: 'path' },
  );
  if (templateValue) {
    return join(options.outputDir, ...templateValue.split('/'));
  }
  const subdir = options.organizeByKind ? sanitizeFilename(asset.kind ?? 'other') : '';
  return subdir ? join(options.outputDir, subdir) : options.outputDir;
}

function buildResolvedFileName({ asset, responseHeaders = {}, index = 0, suggestedExtension = null }) {
  const raw = buildTargetFileName({
    asset,
    responseHeaders,
    index,
  });

  if (extname(raw)) {
    return raw;
  }

  return `${raw}${suggestedExtension ?? ''}`;
}

function hasLikelyExtension(value) {
  return /\.[a-z0-9]{1,6}$/i.test(String(value ?? ''));
}

function buildTemplatedFileName({ asset, options, index = 0, extension = '' }) {
  const templateValue = renderTemplate(
    options.fileNameTemplate,
    buildTemplateContext(asset, index, extension),
    { kind: 'file' },
  );
  if (!templateValue) {
    return null;
  }
  return hasLikelyExtension(templateValue) ? templateValue : `${templateValue}${extension}`;
}

function isStreamingManifest({ url, contentType }) {
  const normalizedType = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const normalizedUrl = String(url ?? '').toLowerCase();
  return normalizedType === 'application/vnd.apple.mpegurl'
    || normalizedType === 'application/x-mpegurl'
    || normalizedType === 'application/dash+xml'
    || normalizedUrl.endsWith('.m3u8')
    || normalizedUrl.endsWith('.mpd');
}

function detectStreamingKind({ url, contentType }) {
  const normalizedType = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  const normalizedUrl = String(url ?? '').toLowerCase();
  if (normalizedType === 'application/dash+xml' || normalizedUrl.endsWith('.mpd')) {
    return 'dash';
  }
  if (
    normalizedType === 'application/vnd.apple.mpegurl'
    || normalizedType === 'application/x-mpegurl'
    || normalizedUrl.endsWith('.m3u8')
  ) {
    return 'hls';
  }
  return null;
}

async function fetchResource(url, options, { asText = false } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= options.retryAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': options.userAgent,
          ...options.headers,
        },
        signal: controller.signal,
        redirect: 'follow',
      });

      const shouldRetryStatus = response.status >= 500 || response.status === 408 || response.status === 429;
      if (!response.ok && shouldRetryStatus && attempt < options.retryAttempts) {
        await response.arrayBuffer().catch(() => null);
        throw new Error(`retryable media response status ${response.status}`);
      }

      if (asText) {
        const text = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          finalUrl: response.url,
          headers: headersToObject(response.headers),
          text,
          attempts: attempt,
        };
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (options.maxBytes > 0 && buffer.byteLength > options.maxBytes) {
        throw new Error(`media file exceeds maxBytes (${buffer.byteLength} > ${options.maxBytes})`);
      }
      return {
        ok: response.ok,
        status: response.status,
        finalUrl: response.url,
        headers: headersToObject(response.headers),
        buffer,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= options.retryAttempts) {
        throw error;
      }
      const delay = options.retryBackoffMs * attempt;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError ?? new Error('media fetch failed');
}

async function fetchMedia(asset, options) {
  return fetchResource(asset.url, options, { asText: false });
}

async function resolveHlsManifest(url, options, depth = 0) {
  if (depth > 4) {
    throw new Error('hls manifest nesting exceeded safety limit');
  }

  const manifest = await fetchResource(url, options, { asText: true });
  if (!manifest.ok) {
    throw new Error(`failed to fetch hls manifest (${manifest.status})`);
  }

  const lines = manifest.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const variants = [];
  const segments = [];
  let pendingStreamInf = null;
  let initSegment = null;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/i)?.[1] ?? 0);
      pendingStreamInf = { bandwidth };
      continue;
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = line.match(/URI="([^"]+)"/i)?.[1] ?? null;
      if (uri) {
        initSegment = new URL(uri, manifest.finalUrl).href;
      }
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    if (pendingStreamInf) {
      variants.push({
        bandwidth: pendingStreamInf.bandwidth,
        url: new URL(line, manifest.finalUrl).href,
      });
      pendingStreamInf = null;
      continue;
    }

    segments.push(new URL(line, manifest.finalUrl).href);
  }

  if (variants.length > 0) {
    const selected = variants.sort((left, right) => right.bandwidth - left.bandwidth)[0];
    return resolveHlsManifest(selected.url, options, depth + 1);
  }

  return {
    type: 'hls',
    manifestUrl: manifest.finalUrl,
    manifestText: manifest.text,
    segmentUrls: initSegment ? [initSegment, ...segments] : segments,
    suggestedExtension: getExtensionFromUrl(segments[0] ?? '') ?? '.ts',
  };
}

function buildMpdSegmentUrls(representation, resolvedBaseUrl, doc) {
  const segmentList = representation.querySelector('SegmentList');
  if (segmentList) {
    const initialization = segmentList.querySelector('Initialization');
    const segmentUrls = [];
    if (initialization?.getAttribute('sourceURL')) {
      segmentUrls.push(new URL(initialization.getAttribute('sourceURL'), resolvedBaseUrl).href);
    }
    for (const node of segmentList.querySelectorAll('SegmentURL')) {
      const media = node.getAttribute('media');
      if (media) {
        segmentUrls.push(new URL(media, resolvedBaseUrl).href);
      }
    }
    return {
      segmentUrls,
      initializationUrl: initialization?.getAttribute('sourceURL')
        ? new URL(initialization.getAttribute('sourceURL'), resolvedBaseUrl).href
        : null,
    };
  }

  const template = representation.querySelector('SegmentTemplate');
  if (!template) {
    return {
      segmentUrls: [],
      initializationUrl: null,
    };
  }

  const mediaTemplate = template.getAttribute('media');
  if (!mediaTemplate) {
    return {
      segmentUrls: [],
      initializationUrl: null,
    };
  }

  const initialization = template.getAttribute('initialization');
  const startNumber = Number(template.getAttribute('startNumber') ?? 1) || 1;
  const timescale = Number(template.getAttribute('timescale') ?? 1) || 1;
  const duration = Number(template.getAttribute('duration') ?? 0) || 0;
  const urls = [];

  if (initialization) {
    urls.push(new URL(initialization.replaceAll('$RepresentationID$', representation.getAttribute('id') ?? ''), resolvedBaseUrl).href);
  }

  const timeline = template.querySelector('SegmentTimeline');
  if (timeline) {
    let currentNumber = startNumber;
    for (const node of timeline.querySelectorAll('S')) {
      const repeat = Number(node.getAttribute('r') ?? 0) || 0;
      const count = repeat >= 0 ? repeat + 1 : 1;
      for (let index = 0; index < count; index += 1) {
        const resolved = mediaTemplate
          .replaceAll('$RepresentationID$', representation.getAttribute('id') ?? '')
          .replaceAll('$Number$', String(currentNumber));
        urls.push(new URL(resolved, resolvedBaseUrl).href);
        currentNumber += 1;
      }
    }
    return {
      segmentUrls: urls,
      initializationUrl: initialization
        ? new URL(initialization.replaceAll('$RepresentationID$', representation.getAttribute('id') ?? ''), resolvedBaseUrl).href
        : null,
    };
  }

  const totalSeconds = parseIsoDurationToSeconds(doc.querySelector('MPD')?.getAttribute('mediaPresentationDuration'));
  if (duration > 0 && totalSeconds) {
    const totalSegments = Math.ceil((totalSeconds * timescale) / duration);
    for (let index = 0; index < totalSegments; index += 1) {
      const resolved = mediaTemplate
        .replaceAll('$RepresentationID$', representation.getAttribute('id') ?? '')
        .replaceAll('$Number$', String(startNumber + index));
      urls.push(new URL(resolved, resolvedBaseUrl).href);
    }
  }

  return {
    segmentUrls: urls,
    initializationUrl: initialization
      ? new URL(initialization.replaceAll('$RepresentationID$', representation.getAttribute('id') ?? ''), resolvedBaseUrl).href
      : null,
  };
}

async function resolveDashManifest(url, options) {
  const manifest = await fetchResource(url, options, { asText: true });
  if (!manifest.ok) {
    throw new Error(`failed to fetch dash manifest (${manifest.status})`);
  }

  const dom = new JSDOM(manifest.text, {
    contentType: 'text/xml',
    url: manifest.finalUrl,
  });
  const doc = dom.window.document;
  const representations = [...doc.querySelectorAll('Representation')];
  if (representations.length === 0) {
    throw new Error('dash manifest does not contain any Representation nodes');
  }

  const selected = representations.sort((left, right) => {
    return Number(right.getAttribute('bandwidth') ?? 0) - Number(left.getAttribute('bandwidth') ?? 0);
  })[0];

  const baseUrlParts = [];
  let current = selected;
  while (current) {
    const base = current.querySelector(':scope > BaseURL');
    if (base?.textContent?.trim()) {
      baseUrlParts.unshift(base.textContent.trim());
    }
    current = current.parentElement;
  }

  let resolvedBaseUrl = manifest.finalUrl;
  for (const part of baseUrlParts) {
    resolvedBaseUrl = new URL(part, resolvedBaseUrl).href;
  }

  const { segmentUrls, initializationUrl } = buildMpdSegmentUrls(selected, resolvedBaseUrl, doc);
  if (segmentUrls.length === 0) {
    const directFileUrl = getExtensionFromUrl(resolvedBaseUrl) ? resolvedBaseUrl : null;
    if (directFileUrl) {
      return {
        type: 'dash',
        manifestUrl: manifest.finalUrl,
        manifestText: manifest.text,
        segmentUrls: [directFileUrl],
        suggestedExtension: getExtensionFromUrl(directFileUrl) ?? '.mp4',
      };
    }

    throw new Error('dash manifest did not resolve any segment URLs');
  }

  return {
    type: 'dash',
    manifestUrl: manifest.finalUrl,
    manifestText: manifest.text,
    segmentUrls,
    suggestedExtension: getExtensionFromUrl(initializationUrl ?? '') ?? getExtensionFromUrl(segmentUrls.at(-1) ?? '') ?? '.mp4',
  };
}

async function downloadStreamingMedia(asset, options, { index = 0 } = {}) {
  const streamingKind = detectStreamingKind({
    url: asset.url,
    contentType: asset.mimeType,
  });
  if (!streamingKind) {
    throw new Error('streaming media type could not be determined');
  }

  const manifest = streamingKind === 'dash'
    ? await resolveDashManifest(asset.url, options)
    : await resolveHlsManifest(asset.url, options);
  const targetDir = buildTargetDir(asset, options);
  await ensureDir(targetDir);
  const explicitBaseName = sanitizeFilename(String(asset.title ?? '').trim());
  const fileName = explicitBaseName
    ? `${explicitBaseName}${manifest.suggestedExtension ?? ''}`
    : buildResolvedFileName({
        asset,
        responseHeaders: {},
        index,
        suggestedExtension: manifest.suggestedExtension,
      });
  const targetPath = join(targetDir, fileName);

  if (options.skipExisting) {
    try {
      const existing = await stat(targetPath);
      const skipped = {
        ok: true,
        url: asset.url,
        finalUrl: manifest.manifestUrl,
        path: targetPath,
        fileName,
        kind: asset.kind ?? null,
        source: asset.source ?? null,
        bytes: existing.size,
        contentType: asset.mimeType ?? null,
        status: 200,
        downloadedAt: new Date().toISOString(),
        skipped: true,
        attempts: 0,
        streaming: {
          type: manifest.type,
          manifestUrl: manifest.manifestUrl,
          segmentCount: manifest.segmentUrls.length,
        },
      };
      if (options.manifestPath) {
        await appendNdjson(options.manifestPath, skipped);
      }
      return skipped;
    } catch {
      // continue
    }
  }

  const segmentResults = await mapWithConcurrency(manifest.segmentUrls, options.concurrency, async (segmentUrl) => {
    const response = await fetchResource(segmentUrl, options, { asText: false });
    if (!response.ok) {
      throw new Error(`stream segment download failed (${response.status}): ${segmentUrl}`);
    }
    return {
      buffer: response.buffer,
      attempts: response.attempts ?? 1,
    };
  });
  const buffer = Buffer.concat(segmentResults.map((item) => item.buffer));
  if (options.maxBytes > 0 && buffer.byteLength > options.maxBytes) {
    throw new Error(`stream output exceeds maxBytes (${buffer.byteLength} > ${options.maxBytes})`);
  }

  await writeFile(targetPath, buffer);

  const record = {
    ok: true,
    url: asset.url,
    finalUrl: manifest.manifestUrl,
    path: targetPath,
    fileName,
    kind: asset.kind ?? null,
    source: asset.source ?? null,
    title: asset.title ?? null,
    pageUrl: asset.pageUrl ?? null,
    bytes: buffer.byteLength,
    contentType: streamingKind === 'dash' ? 'application/dash+merged' : 'application/vnd.apple.mpegurl+merged',
    status: 200,
    downloadedAt: new Date().toISOString(),
    attempts: Math.max(1, ...segmentResults.map((item) => item.attempts ?? 1)),
    streaming: {
      type: manifest.type,
      manifestUrl: manifest.manifestUrl,
      segmentCount: manifest.segmentUrls.length,
    },
  };

  if (options.manifestPath) {
    await appendNdjson(options.manifestPath, record);
  }

  return record;
}

export async function downloadMediaAsset(assetInput, options = {}) {
  const asset = normalizeAsset(assetInput);
  const normalized = normalizeDownloadOptions(options);
  if (isStreamingManifest({ url: asset.url, contentType: asset.mimeType })) {
    return downloadStreamingMedia(asset, normalized, {
      index: Number(options.index ?? 0) || 0,
    });
  }

  const guessedFileName = buildTargetFileName({
    asset,
    responseHeaders: {},
    index: Number(options.index ?? 0) || 0,
  });
  const targetDir = buildTargetDir(asset, normalized);
  await ensureDir(targetDir);
  const optimisticFileName =
    buildTemplatedFileName({
      asset,
      options: normalized,
      index: Number(options.index ?? 0) || 0,
      extension: extname(guessedFileName),
    })
    ?? guessedFileName;
  const optimisticTargetPath = join(targetDir, optimisticFileName);

  if (normalized.skipExisting) {
    try {
      const existing = await stat(optimisticTargetPath);
      const record = {
        ok: true,
        url: asset.url,
        finalUrl: asset.url,
        path: optimisticTargetPath,
        fileName: optimisticFileName,
        kind: asset.kind ?? null,
        source: asset.source ?? null,
        title: asset.title ?? null,
        pageUrl: asset.pageUrl ?? null,
        bytes: existing.size,
        contentType: asset.mimeType ?? null,
        status: 200,
        downloadedAt: new Date().toISOString(),
        skipped: true,
        attempts: 0,
      };
      if (normalized.manifestPath) {
        await appendNdjson(normalized.manifestPath, record);
      }
      return record;
    } catch {
      // continue to network fetch
    }
  }

  const response = await fetchMedia(asset, normalized);
  if (!response.ok) {
    throw new Error(`media download failed with status ${response.status}`);
  }

  const fileName = buildTargetFileName({
    asset,
    responseHeaders: response.headers,
    index: Number(options.index ?? 0) || 0,
  });
  const finalFileName =
    buildTemplatedFileName({
      asset,
      options: normalized,
      index: Number(options.index ?? 0) || 0,
      extension: getExtensionFromMimeType(response.headers['content-type']) ?? extname(fileName),
    })
    ?? fileName;
  const targetPath = join(targetDir, finalFileName);

  await writeFile(targetPath, response.buffer);

  const record = {
    ok: true,
    url: asset.url,
    finalUrl: response.finalUrl,
    path: targetPath,
    fileName: finalFileName,
    kind: asset.kind ?? null,
    source: asset.source ?? null,
    title: asset.title ?? null,
    pageUrl: asset.pageUrl ?? null,
    bytes: response.buffer.byteLength,
    contentType: response.headers['content-type'] ?? null,
    status: response.status,
    downloadedAt: new Date().toISOString(),
    attempts: response.attempts ?? 1,
  };

  if (normalized.manifestPath) {
    await appendNdjson(normalized.manifestPath, record);
  }

  return record;
}

export async function downloadMediaAssets(inputAssets, options = {}) {
  const normalized = normalizeDownloadOptions(options);
  const filteredAssets = filterMediaAssets(inputAssets, normalized);
  const assets = [];
  const seen = new Set();

  for (const assetInput of Array.isArray(filteredAssets) ? filteredAssets : []) {
    const asset = normalizeAsset(assetInput);
    if (!asset.url || seen.has(asset.url)) {
      continue;
    }
    seen.add(asset.url);
    assets.push(asset);
  }

  const results = await mapWithConcurrency(assets, normalized.concurrency, async (asset, index) => {
    try {
      return await downloadMediaAsset(asset, {
        ...normalized,
        index,
      });
    } catch (error) {
      const failure = {
        ok: false,
        url: asset.url,
        finalUrl: null,
        path: null,
        fileName: null,
        kind: asset.kind ?? null,
        source: asset.source ?? null,
        title: asset.title ?? null,
        pageUrl: asset.pageUrl ?? null,
        bytes: 0,
        contentType: asset.mimeType ?? null,
        status: null,
        downloadedAt: new Date().toISOString(),
        attempts: normalized.retryAttempts,
        error: error?.message ?? String(error),
      };

      if (normalized.manifestPath) {
        await appendNdjson(normalized.manifestPath, failure);
      }
      if (normalized.failuresPath) {
        await appendNdjson(normalized.failuresPath, failure);
      }

      return failure;
    }
  });

  return {
    total: results.length,
    downloaded: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    items: results,
    outputDir: normalized.outputDir,
  };
}

export function collectMediaAssetsFromResult(result, fields = ['media', 'images', 'videos', 'audio']) {
  const extracted = result?.extracted ?? {};
  const assets = [];
  const seen = new Set();

  for (const field of fields) {
    const values = extracted?.[field];
    if (!Array.isArray(values)) {
      continue;
    }

    for (const value of values) {
      const asset = normalizeAsset({
        ...value,
        pageUrl: result?.finalUrl ?? null,
      });
      if (seen.has(asset.url)) {
        continue;
      }
      seen.add(asset.url);
      assets.push(asset);
    }
  }

  return assets;
}

export function filterMediaAssets(inputAssets, options = {}) {
  const normalized = normalizeDownloadOptions(options);
  const items = Array.isArray(inputAssets) ? inputAssets : [];
  return items
    .map((item) => normalizeAsset(item))
    .filter((asset) => {
      if (normalized.mediaInclude.length > 0 && !normalized.mediaInclude.some((pattern) => pattern.test(asset.url))) {
        return false;
      }
      if (normalized.mediaExclude.length > 0 && normalized.mediaExclude.some((pattern) => pattern.test(asset.url))) {
        return false;
      }
      return true;
    });
}

export async function readMediaDownloadManifest(manifestPath) {
  const targetPath = resolve(String(manifestPath));
  const raw = await readFile(targetPath, 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function collectFailedMediaDownloads(records = []) {
  const items = Array.isArray(records) ? records : [];
  const failures = [];
  const seen = new Set();

  for (const record of items) {
    if (!record || typeof record !== 'object') {
      continue;
    }
    if (record.ok !== false) {
      continue;
    }

    const asset = normalizeAsset({
      url: record.url,
      kind: record.kind ?? null,
      source: record.source ?? null,
      mimeType: record.contentType ?? null,
      title: record.title ?? null,
      pageUrl: record.pageUrl ?? null,
    });
    if (!asset.url || seen.has(asset.url)) {
      continue;
    }
    seen.add(asset.url);
    failures.push(asset);
  }

  return failures;
}

export async function retryFailedMediaDownloads(manifestPath, options = {}) {
  const records = await readMediaDownloadManifest(manifestPath);
  const failedAssets = collectFailedMediaDownloads(records);
  return downloadMediaAssets(failedAssets, options);
}
