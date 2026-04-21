import { JSDOM } from 'jsdom';

const SUPPORTED_KINDS = new Set(['image', 'video', 'audio']);
const MEDIA_EXTENSION_MAP = new Map([
  ['.jpg', 'image'],
  ['.jpeg', 'image'],
  ['.png', 'image'],
  ['.gif', 'image'],
  ['.webp', 'image'],
  ['.avif', 'image'],
  ['.svg', 'image'],
  ['.bmp', 'image'],
  ['.ico', 'image'],
  ['.tif', 'image'],
  ['.tiff', 'image'],
  ['.mp4', 'video'],
  ['.m4v', 'video'],
  ['.mov', 'video'],
  ['.mkv', 'video'],
  ['.webm', 'video'],
  ['.m3u8', 'video'],
  ['.mpd', 'video'],
  ['.ts', 'video'],
  ['.avi', 'video'],
  ['.flv', 'video'],
  ['.wmv', 'video'],
  ['.mp3', 'audio'],
  ['.m4a', 'audio'],
  ['.aac', 'audio'],
  ['.wav', 'audio'],
  ['.flac', 'audio'],
  ['.ogg', 'audio'],
  ['.oga', 'audio'],
  ['.opus', 'audio'],
  ['.weba', 'audio'],
  ['.wma', 'audio'],
]);

const MEDIA_TYPE_HINTS = {
  image: ['image', 'thumbnail', 'poster', 'icon', 'logo'],
  video: ['video', 'stream', 'trailer', 'clip', 'movie', 'episode'],
  audio: ['audio', 'music', 'song', 'track', 'podcast', 'voice'],
};

function normalizeKinds(kinds) {
  const source = Array.isArray(kinds) && kinds.length > 0 ? kinds : ['image', 'video', 'audio'];
  return [...new Set(source.map((item) => String(item ?? '').trim().toLowerCase()).filter((item) => SUPPORTED_KINDS.has(item)))];
}

function normalizeMediaRule(rule = {}) {
  return {
    all: rule.all === true,
    format: rule.format === 'url' ? 'url' : 'object',
    kinds: normalizeKinds(rule.kinds),
    includeDom: rule.includeDom !== false,
    includeMeta: rule.includeMeta !== false,
    includeJsonLd: rule.includeJsonLd !== false,
    includeNetwork: rule.includeNetwork !== false,
    includeResponse: rule.includeResponse !== false,
    maxItems: Number(rule.maxItems ?? 50) || 50,
  };
}

function resolveUrl(rawUrl, baseUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  const candidate = rawUrl.trim();
  if (!candidate || candidate.startsWith('javascript:')) {
    return null;
  }

  try {
    return new URL(candidate, baseUrl).href;
  } catch {
    return null;
  }
}

function detectKindFromMime(mimeType) {
  const value = String(mimeType ?? '').trim().toLowerCase();
  if (!value) {
    return null;
  }

  if (value.startsWith('image/')) {
    return 'image';
  }
  if (value.startsWith('video/')) {
    return 'video';
  }
  if (value.startsWith('audio/')) {
    return 'audio';
  }

  if (value.includes('application/vnd.apple.mpegurl') || value.includes('application/x-mpegurl') || value.includes('application/dash+xml')) {
    return 'video';
  }

  return null;
}

function detectKindFromUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return null;
  }

  try {
    const pathname = new URL(rawUrl, 'https://example.invalid').pathname.toLowerCase();
    for (const [extension, kind] of MEDIA_EXTENSION_MAP.entries()) {
      if (pathname.endsWith(extension)) {
        return kind;
      }
    }
  } catch {
    return null;
  }

  return null;
}

function detectKindFromHint(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  for (const [kind, hints] of Object.entries(MEDIA_TYPE_HINTS)) {
    if (hints.some((hint) => normalized.includes(hint))) {
      return kind;
    }
  }

  return null;
}

function parseSrcset(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function shouldIncludeKind(kind, options) {
  return Boolean(kind) && options.kinds.includes(kind);
}

function buildAssetKey(asset) {
  return `${asset.kind}:${asset.url}`;
}

function finalizeAssets(assets, options) {
  const unique = [];
  const seen = new Set();

  for (const asset of assets) {
    const key = buildAssetKey(asset);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(asset);
    if (unique.length >= options.maxItems) {
      break;
    }
  }

  if (options.format === 'url') {
    return unique.map((item) => item.url);
  }

  return unique;
}

function pushAsset(assets, options, input) {
  const url = resolveUrl(input.url, input.baseUrl);
  if (!url) {
    return;
  }

  const kind = input.kind ?? detectKindFromMime(input.mimeType) ?? detectKindFromUrl(url) ?? detectKindFromHint(input.hint);
  if (!shouldIncludeKind(kind, options)) {
    return;
  }

  assets.push({
    url,
    kind,
    source: input.source,
    tagName: input.tagName ?? null,
    attribute: input.attribute ?? null,
    mimeType: input.mimeType ?? null,
    title: input.title ?? null,
    alt: input.alt ?? null,
    poster: input.poster ? resolveUrl(input.poster, input.baseUrl) : null,
    width: Number(input.width ?? 0) || null,
    height: Number(input.height ?? 0) || null,
  });
}

function extractFromResponse(response, assets, options) {
  const contentType = response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? null;
  const kind = detectKindFromMime(contentType) ?? detectKindFromUrl(response.finalUrl);
  if (!shouldIncludeKind(kind, options)) {
    return;
  }

  pushAsset(assets, options, {
    url: response.finalUrl,
    baseUrl: response.finalUrl,
    kind,
    mimeType: contentType,
    source: 'response',
  });
}

function createDomDocument(response) {
  const dom = new JSDOM(response.body, {
    url: response.finalUrl,
  });
  return dom.window.document;
}

function extractFromDom(document, response, assets, options) {
  for (const node of document.querySelectorAll('img')) {
    pushAsset(assets, options, {
      url: node.getAttribute('src') ?? node.getAttribute('data-src') ?? node.getAttribute('data-original'),
      baseUrl: response.finalUrl,
      kind: 'image',
      source: 'dom',
      tagName: 'img',
      attribute: node.getAttribute('src') ? 'src' : node.getAttribute('data-src') ? 'data-src' : 'data-original',
      alt: node.getAttribute('alt'),
      width: node.getAttribute('width'),
      height: node.getAttribute('height'),
    });

    for (const srcsetUrl of parseSrcset(node.getAttribute('srcset'))) {
      pushAsset(assets, options, {
        url: srcsetUrl,
        baseUrl: response.finalUrl,
        kind: 'image',
        source: 'dom',
        tagName: 'img',
        attribute: 'srcset',
        alt: node.getAttribute('alt'),
      });
    }
  }

  for (const node of document.querySelectorAll('video')) {
    pushAsset(assets, options, {
      url: node.getAttribute('src'),
      baseUrl: response.finalUrl,
      kind: 'video',
      source: 'dom',
      tagName: 'video',
      attribute: 'src',
      poster: node.getAttribute('poster'),
      width: node.getAttribute('width'),
      height: node.getAttribute('height'),
    });

    pushAsset(assets, options, {
      url: node.getAttribute('poster'),
      baseUrl: response.finalUrl,
      kind: 'image',
      source: 'dom',
      tagName: 'video',
      attribute: 'poster',
      width: node.getAttribute('width'),
      height: node.getAttribute('height'),
    });
  }

  for (const node of document.querySelectorAll('audio')) {
    pushAsset(assets, options, {
      url: node.getAttribute('src'),
      baseUrl: response.finalUrl,
      kind: 'audio',
      source: 'dom',
      tagName: 'audio',
      attribute: 'src',
    });
  }

  for (const node of document.querySelectorAll('source')) {
    const parentTag = node.parentElement?.tagName?.toLowerCase?.() ?? null;
    const hintedKind =
      parentTag === 'video'
        ? 'video'
        : parentTag === 'audio'
          ? 'audio'
          : parentTag === 'picture'
            ? 'image'
            : detectKindFromMime(node.getAttribute('type'));

    pushAsset(assets, options, {
      url: node.getAttribute('src'),
      baseUrl: response.finalUrl,
      kind: hintedKind,
      mimeType: node.getAttribute('type'),
      source: 'dom',
      tagName: 'source',
      attribute: 'src',
      poster: parentTag === 'video' ? node.parentElement?.getAttribute?.('poster') : null,
    });

    for (const srcsetUrl of parseSrcset(node.getAttribute('srcset'))) {
      pushAsset(assets, options, {
        url: srcsetUrl,
        baseUrl: response.finalUrl,
        kind: hintedKind ?? 'image',
        mimeType: node.getAttribute('type'),
        source: 'dom',
        tagName: 'source',
        attribute: 'srcset',
      });
    }
  }

  for (const node of document.querySelectorAll('a[href]')) {
    pushAsset(assets, options, {
      url: node.getAttribute('href'),
      baseUrl: response.finalUrl,
      source: 'dom',
      tagName: 'a',
      attribute: 'href',
    });
  }

  for (const node of document.querySelectorAll('[style*="url("]')) {
    const style = node.getAttribute('style') ?? '';
    const matches = style.matchAll(/url\((['"]?)([^'")]+)\1\)/gi);
    for (const match of matches) {
      pushAsset(assets, options, {
        url: match[2],
        baseUrl: response.finalUrl,
        kind: 'image',
        source: 'dom',
        tagName: node.tagName?.toLowerCase?.() ?? null,
        attribute: 'style',
      });
    }
  }
}

function extractFromMeta(document, response, assets, options) {
  const metaMappings = [
    ['meta[property="og:image"]', 'image', 'content'],
    ['meta[property="og:image:url"]', 'image', 'content'],
    ['meta[property="og:video"]', 'video', 'content'],
    ['meta[property="og:video:url"]', 'video', 'content'],
    ['meta[property="og:audio"]', 'audio', 'content'],
    ['meta[property="og:audio:url"]', 'audio', 'content'],
    ['meta[name="twitter:image"]', 'image', 'content'],
    ['meta[name="twitter:image:src"]', 'image', 'content'],
    ['meta[name="twitter:player:stream"]', 'video', 'content'],
    ['link[rel="image_src"]', 'image', 'href'],
  ];

  for (const [selector, kind, attribute] of metaMappings) {
    for (const node of document.querySelectorAll(selector)) {
      pushAsset(assets, options, {
        url: node.getAttribute(attribute),
        baseUrl: response.finalUrl,
        kind,
        source: 'meta',
        tagName: node.tagName?.toLowerCase?.() ?? null,
        attribute,
        title: node.getAttribute('property') ?? node.getAttribute('name') ?? null,
      });
    }
  }

  for (const node of document.querySelectorAll('link[rel~="preload"][href]')) {
    const kind = detectKindFromHint(node.getAttribute('as'));
    pushAsset(assets, options, {
      url: node.getAttribute('href'),
      baseUrl: response.finalUrl,
      kind,
      source: 'meta',
      tagName: 'link',
      attribute: 'href',
      mimeType: node.getAttribute('type'),
      title: node.getAttribute('as'),
    });
  }
}

function extractFromJsonLd(document, response, assets, options) {
  function walk(value, context = {}) {
    if (!value) {
      return;
    }

    if (typeof value === 'string') {
      pushAsset(assets, options, {
        url: value,
        baseUrl: response.finalUrl,
        kind: context.kind,
        mimeType: context.mimeType,
        source: 'jsonld',
        title: context.title,
        hint: context.property,
      });
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item, context);
      }
      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    const typeValue = Array.isArray(value['@type']) ? value['@type'].join(' ') : value['@type'];
    const contextKind =
      detectKindFromHint(typeValue)
      ?? detectKindFromHint(value.encodingFormat)
      ?? context.kind
      ?? null;
    const title = value.name ?? value.headline ?? context.title ?? null;
    const mimeType = value.encodingFormat ?? context.mimeType ?? null;

    const directCandidates = [
      ['contentUrl', contextKind],
      ['url', contextKind],
      ['embedUrl', contextKind ?? 'video'],
      ['thumbnailUrl', 'image'],
      ['image', 'image'],
      ['images', 'image'],
      ['logo', 'image'],
      ['video', 'video'],
      ['audio', 'audio'],
      ['associatedMedia', contextKind],
      ['trailer', 'video'],
    ];

    for (const [property, kind] of directCandidates) {
      if (!(property in value)) {
        continue;
      }

      walk(value[property], {
        kind,
        mimeType,
        title,
        property,
      });
    }

    for (const [property, nextValue] of Object.entries(value)) {
      if (directCandidates.some(([candidate]) => candidate === property)) {
        continue;
      }

      if (nextValue && typeof nextValue === 'object') {
        walk(nextValue, {
          kind: contextKind,
          mimeType,
          title,
          property,
        });
      }
    }
  }

  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    const text = node.textContent?.trim();
    if (!text) {
      continue;
    }

    try {
      walk(JSON.parse(text), {});
    } catch {
      continue;
    }
  }
}

function extractFromNetwork(response, assets, options) {
  const requests = Array.isArray(response.debug?.requests) ? response.debug.requests : [];
  for (const request of requests) {
    const mimeType = request.mimeType ?? request.responseHeaders?.['content-type'] ?? request.responseHeaders?.['Content-Type'] ?? null;
    pushAsset(assets, options, {
      url: request.url,
      baseUrl: response.finalUrl,
      kind: detectKindFromMime(mimeType) ?? detectKindFromUrl(request.url),
      mimeType,
      source: 'network',
      title: request.transport ?? null,
    });
  }
}

export function extractMediaAssets(response, rule = {}) {
  const options = normalizeMediaRule(rule);
  const assets = [];
  const contentType = String(response.headers?.['content-type'] ?? response.headers?.['Content-Type'] ?? '').toLowerCase();
  const looksLikeHtml = contentType.includes('html') || /<html|<head|<body|<img|<video|<audio|<meta/i.test(response.body);

  if (options.includeResponse) {
    extractFromResponse(response, assets, options);
  }

  let document = null;
  if (looksLikeHtml && (options.includeDom || options.includeMeta || options.includeJsonLd)) {
    document = createDomDocument(response);
  }

  if (document && options.includeDom) {
    extractFromDom(document, response, assets, options);
  }

  if (document && options.includeMeta) {
    extractFromMeta(document, response, assets, options);
  }

  if (document && options.includeJsonLd) {
    extractFromJsonLd(document, response, assets, options);
  }

  if (options.includeNetwork) {
    extractFromNetwork(response, assets, options);
  }

  return finalizeAssets(assets, options);
}

export function buildMediaExtractRules(options = {}) {
  const fieldNames = {
    media: 'media',
    images: 'images',
    videos: 'videos',
    audio: 'audio',
    ...(options.fieldNames ?? {}),
  };

  const baseRule = {
    type: 'media',
    all: true,
    format: options.format === 'url' ? 'url' : 'object',
    maxItems: Number(options.maxItems ?? 200) || 200,
    includeDom: options.includeDom !== false,
    includeMeta: options.includeMeta !== false,
    includeJsonLd: options.includeJsonLd !== false,
    includeNetwork: options.includeNetwork !== false,
  };

  const rules = [];
  if (options.includeCombined !== false) {
    rules.push({
      ...baseRule,
      name: fieldNames.media,
    });
  }
  if (options.includeImages !== false) {
    rules.push({
      ...baseRule,
      name: fieldNames.images,
      kinds: ['image'],
    });
  }
  if (options.includeVideos !== false) {
    rules.push({
      ...baseRule,
      name: fieldNames.videos,
      kinds: ['video'],
    });
  }
  if (options.includeAudio !== false) {
    rules.push({
      ...baseRule,
      name: fieldNames.audio,
      kinds: ['audio'],
    });
  }

  return rules;
}
