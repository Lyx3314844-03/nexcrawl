import { OmniCrawler } from './omnicrawler.js';
import {
  detectGraphQLEndpoints,
  executeGraphQL,
  introspectSchema,
  extractPersistedQueryHints,
  buildGraphQLStarterOperation,
  buildGraphQLRequestPlan,
  fetchAllPages as fetchAllGraphQLPages,
} from '../fetchers/graphql-fetcher.js';
import { fetchWithHttp } from '../fetchers/http-fetcher.js';
import {
  fetchWebSocket,
  subscribeWebSocket,
  analyzeWebSocketTranscript,
  buildWebSocketSessionPlan,
} from '../fetchers/ws-fetcher.js';
import { classifyProtectionSurface } from '../reverse/ai-analysis.js';
import { detectCloudflareChallenge } from '../reverse/cloudflare-solver.js';

function mergeBrowserConfig(config = {}, browser = {}) {
  return {
    ...(config.browser ?? {}),
    ...browser,
  };
}

function mergeConfigTrees(base = {}, next = {}) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) {
    return { ...(next ?? {}) };
  }
  const output = { ...base };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && output[key]
      && typeof output[key] === 'object'
      && !Array.isArray(output[key])
    ) {
      output[key] = mergeConfigTrees(output[key], value);
      continue;
    }
    output[key] = Array.isArray(value) ? [...value] : value;
  }
  return output;
}

export class HttpCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'http',
    });
  }
}

export class CheerioCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'cheerio',
    });
  }
}

export class BrowserCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'browser',
    });
  }
}

export class HybridCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'hybrid',
    });
  }
}

export class MediaCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'browser',
    });
    this.useMediaExtraction({
      format: 'object',
      includeNetwork: config.includeNetwork !== false,
      maxItems: config.maxMediaItems ?? 200,
    });
  }
}

export class PuppeteerCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'browser',
    });
    this.setBrowserOptions(mergeBrowserConfig(config, { engine: 'puppeteer' }));
  }
}

export class PuppeteerCoreCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'browser',
    });
    this.setBrowserOptions(mergeBrowserConfig(config, { engine: 'puppeteer-core' }));
  }
}

export class PlaywrightCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'browser',
    });
    this.setBrowserOptions(mergeBrowserConfig(config, { engine: 'playwright' }));
  }
}

export class PlaywrightCoreCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'browser',
    });
    this.setBrowserOptions(mergeBrowserConfig(config, { engine: 'playwright-core' }));
  }
}

export class PatchrightCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'browser',
    });
    this.setBrowserOptions(mergeBrowserConfig(config, { engine: 'patchright' }));
  }
}

function withMergedHeaders(config = {}, headers = {}) {
  return {
    ...config,
    headers: {
      ...(config.headers ?? {}),
      ...headers,
    },
  };
}

function buildJsonPathRules(fieldMap = {}) {
  return Object.entries(fieldMap).map(([name, path]) => ({
    name,
    type: 'json',
    path,
  }));
}

function buildXPathRules(fieldMap = {}, defaults = {}) {
  return Object.entries(fieldMap).map(([name, expression]) => ({
    name,
    type: 'xpath',
    expression,
    xpath: expression,
    ...defaults,
  }));
}

function getHeaderIgnoreCase(headers = {}, headerName) {
  const target = String(headerName ?? '').toLowerCase();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (String(name).toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function normalizeProbeBody(body) {
  if (typeof body === 'string') {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }
  return '';
}

function stripHtmlForSignalText(body = '') {
  return normalizeProbeBody(body)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectUniversalFrontendSignals({ url = '', body = '' } = {}) {
  const normalizedUrl = String(url).toLowerCase();
  const html = normalizeProbeBody(body);
  const lower = html.toLowerCase();
  const frameworks = [];
  const hydrationSources = [];
  const rootContainers = [];

  const addUnique = (list, value) => {
    if (value && !list.includes(value)) {
      list.push(value);
    }
  };

  if (/_next\/static|id=["']__next["']|id=["']__next_data["']|__next_data__/i.test(lower)) {
    addUnique(frameworks, 'nextjs');
  }
  if (/_nuxt\/|id=["']__nuxt["']|window\.__nuxt__|__nuxt__/i.test(lower)) {
    addUnique(frameworks, 'nuxt');
  }
  if (/__remixcontext|remixmanifest|routeModules/i.test(lower)) {
    addUnique(frameworks, 'remix');
  }
  if (/window\.__apollo_state__|apollo\.restore\(|__apollo_state__/i.test(lower)) {
    addUnique(frameworks, 'apollo');
  }
  if (/__preloaded_state__|__initial_state__|redux/i.test(lower)) {
    addUnique(frameworks, 'redux');
  }
  if (/\/@vite\/client|data-vite-dev-id|type=["']module["'][^>]*>[\s\S]*?hydrate/i.test(lower)) {
    addUnique(frameworks, 'vite');
  }
  if (/_app\/immutable|data-sveltekit/i.test(lower)) {
    addUnique(frameworks, 'sveltekit');
  }

  if (/id=["']__next_data["']|__next_data__/i.test(lower)) {
    addUnique(hydrationSources, '__NEXT_DATA__');
  }
  if (/window\.__nuxt__|__nuxt__/i.test(lower)) {
    addUnique(hydrationSources, '__NUXT__');
  }
  if (/window\.__apollo_state__|__apollo_state__/i.test(lower)) {
    addUnique(hydrationSources, '__APOLLO_STATE__');
  }
  if (/__preloaded_state__/i.test(lower)) {
    addUnique(hydrationSources, '__PRELOADED_STATE__');
  }
  if (/__initial_state__/i.test(lower)) {
    addUnique(hydrationSources, '__INITIAL_STATE__');
  }

  for (const match of lower.matchAll(/id=["'](__next|__nuxt|app|root)["']/gi)) {
    addUnique(rootContainers, match[1]);
  }

  const scriptCount = (html.match(/<script\b/gi) ?? []).length;
  const inlineScriptCount = (html.match(/<script(?![^>]+src=)[^>]*>/gi) ?? []).length;
  const visibleText = stripHtmlForSignalText(html);
  const visibleTextLength = visibleText.length;
  const appShellLikely =
    rootContainers.length > 0
    && scriptCount >= 2
    && visibleTextLength < 450;

  return {
    frameworks,
    hydrationSources,
    rootContainers,
    scriptCount,
    inlineScriptCount,
    visibleTextLength,
    appShellLikely,
    requiresBrowser: appShellLikely || (frameworks.length > 0 && hydrationSources.length === 0 && visibleTextLength < 300),
    sourceUrlHints: normalizedUrl.includes('/_next/') ? ['_next'] : [],
  };
}

function detectUniversalScrollSignals({ body = '', pageKind = null, frontend = null } = {}) {
  const html = normalizeProbeBody(body);
  const lower = html.toLowerCase();
  const visibleText = stripHtmlForSignalText(html).toLowerCase();
  const evidence = [];

  const virtualListLikely = [
    /\b(react-virtualized|react-window|react-virtuoso|virtuoso|tanstack-virtual|virtual-list|virtualized|recyclerlistview)\b/i.test(lower),
    /\b(data-index=|data-item-index=|aria-setsize=|aria-posinset=)\b/i.test(lower),
  ].some(Boolean);
  if (virtualListLikely) {
    evidence.push('virtual-list-signals');
  }

  const loadMoreLikely = [
    /\b(load more|show more|see more|more results|more items|加载更多|查看更多|更多结果)\b/i.test(visibleText),
    /\b(load more|show more|see more|加载更多|查看更多|更多结果)\b/i.test(lower),
  ].some(Boolean);
  if (loadMoreLikely) {
    evidence.push('load-more-signals');
  }

  const cursorPaginationLikely = /\b(hasnextpage|endcursor|nextcursor|pageinfo|cursor|infinite-scroll|intersectionobserver)\b/i.test(lower);
  if (cursorPaginationLikely) {
    evidence.push('cursor-pagination-signals');
  }

  const collectionLike =
    pageKind === 'listing'
    || pageKind === 'search'
    || /\b(role=["']feed["']|role=["']list["']|role=["']listitem["'])\b/i.test(lower)
    || /\b(search-result|results-grid|product-card|itemlist)\b/i.test(lower);

  const infiniteScrollLikely = virtualListLikely || loadMoreLikely || (collectionLike && cursorPaginationLikely);
  const recommendedAutoScroll = Boolean(
    frontend?.requiresBrowser
    && collectionLike
    && (infiniteScrollLikely || frontend?.appShellLikely),
  );

  return {
    infiniteScrollLikely,
    virtualListLikely,
    loadMoreLikely,
    recommendedAutoScroll,
    evidence,
    autoScroll: recommendedAutoScroll
      ? {
          enabled: true,
          maxScrolls: pageKind === 'search' ? 24 : 40,
          delayMs: 500,
          stabilityThresholdMs: 1500,
          maxStableIterations: 3,
          observeLazyContainers: true,
          requireBottom: true,
          sampleItems: 12,
        }
      : null,
  };
}

function detectUniversalAppType(body = '') {
  const lower = normalizeProbeBody(body).toLowerCase();
  if (/weixinjsbridge|micromessenger/.test(lower)) return 'wechat';
  if (/windvane|aliapp/.test(lower)) return 'taobao';
  if (/jdappnative|jd4android/.test(lower)) return 'jd';
  if (/aweme|douyin/.test(lower)) return 'douyin';
  if (/window\.android|android\.webkit/.test(lower)) return 'android';
  if (/webkit\.messagehandlers|wkwebview/.test(lower)) return 'ios';
  return null;
}

function buildUniversalStrategyHints({ url = '', headers = {}, body = '', kind, frontend = null, graphqlEndpoints = [] } = {}) {
  const html = normalizeProbeBody(body);
  const lower = html.toLowerCase();
  const protection = classifyProtectionSurface({
    status: 200,
    headers,
    body: html,
  });
  const cloudflare = detectCloudflareChallenge({
    headers,
    body: html,
    url,
    status: 200,
  });

  const signerPatterns = [];
  if (/\b(sign|signature|x-signature|authorization|auth-token|nonce|timestamp)\b/i.test(lower)) signerPatterns.push('signature-keywords');
  if (/\b(cryptojs|subtle\.digest|hmac|sha256|sha1|md5|aes|rsa)\b/i.test(lower)) signerPatterns.push('crypto-primitives');
  if (/\b(__webpack_require__|wasm|webassembly|atob\(|btoa\(|fromcharcode)\b/i.test(lower)) signerPatterns.push('runtime-obfuscation');

  const nativePatterns = [];
  if (/\b(fride|frida|jailbreak|root detection|ssl pinning|native bridge|webviewjavascriptbridge|weixinjsbridge|windvane|wkwebview)\b/i.test(lower)) nativePatterns.push('native-bridge-signals');
  if (/\b(android.webkit|uikit|uiviewcontroller|okhttp|retrofit|alamofire|grpc-web|protobuf)\b/i.test(lower)) nativePatterns.push('mobile-stack-signals');

  const webViewPatterns = [];
  if (/\b(weixinjsbridge|webviewjavascriptbridge|windvane|jdappnative|window\.android|window\.webkit\.messagehandlers)\b/i.test(lower)) webViewPatterns.push('embedded-js-bridge');
  if (/micromessenger|aliapp|aweme|jd4android/i.test(lower)) webViewPatterns.push('in-app-ua-signals');
  const appType = detectUniversalAppType(html);

  const lane = nativePatterns.length > 0
    ? 'native-app'
    : protection.classification !== 'normal' || cloudflare.detected === true
      ? 'anti-bot'
      : signerPatterns.length > 0
        ? 'signer'
        : frontend?.requiresBrowser
          ? 'browser-shell'
          : kind === 'graphql'
            ? 'graphql'
            : 'default';

  const recommendedModules = [];
  if (frontend?.requiresBrowser) recommendedModules.push('BrowserCrawler');
  if (signerPatterns.length > 0) recommendedModules.push('reverse-signer-runtime');
  if (protection.classification !== 'normal' || cloudflare.detected === true) recommendedModules.push('cloudflare-solver', 'captcha-solver');
  if (webViewPatterns.length > 0) recommendedModules.push('app-webview');
  if (nativePatterns.length > 0) recommendedModules.push('mobile-crawler', 'native-integration');
  if (kind === 'graphql' || graphqlEndpoints.length > 0) recommendedModules.push('GraphQLCrawler');

  return {
    lane,
    requiresSpecializedStrategy: lane !== 'default' && lane !== 'graphql',
    signerLikely: signerPatterns.length > 0,
    antiBotLikely: protection.classification !== 'normal' || cloudflare.detected === true,
    nativeAppLikely: nativePatterns.length > 0,
    appWebViewLikely: webViewPatterns.length > 0,
    browserShellLikely: Boolean(frontend?.requiresBrowser),
    graphqlLikely: kind === 'graphql' || graphqlEndpoints.length > 0,
    evidence: {
      signerSignals: signerPatterns,
      nativeSignals: nativePatterns,
      appWebViewSignals: webViewPatterns,
      appType,
      protection,
      cloudflare,
    },
    recommendedModules: [...new Set(recommendedModules)],
  };
}

function applyUniversalStrategy(crawler, profile, options = {}) {
  const hints = profile?.strategyHints ?? null;
  if (!hints || options.autoSpecialize === false) {
    return profile;
  }

  if (hints.browserShellLikely || hints.antiBotLikely || hints.appWebViewLikely) {
    crawler.setMode('browser');
    crawler.setBrowserOptions(mergeConfigTrees(crawler._workflowOverrides?.browser ?? {}, {
      headless: crawler._workflowOverrides?.browser?.headless ?? true,
      debug: {
        enabled: true,
        captureNetwork: true,
      },
    }));
  }

  if (profile?.scroll?.autoScroll) {
    crawler.setBrowserOptions(mergeConfigTrees(crawler._workflowOverrides?.browser ?? {}, {
      autoScroll: profile.scroll.autoScroll,
      debug: {
        enabled: true,
        captureNetwork: true,
        maxRequests: Number(options.maxAutoScrollRequests ?? 120) || 120,
      },
    }));
  }

  if (hints.antiBotLikely) {
    crawler.useCloudflareSolver({
      enabled: true,
      maxWaitMs: Number(options.cloudflareMaxWaitMs ?? 30000),
    });
    crawler.useBehaviorSimulation({
      enabled: true,
      preset: 'adaptive',
    });

    const captchaProvider = options.captchaProvider ?? null;
    const captchaApiKey = options.captchaApiKey ?? null;
    if (captchaProvider && captchaApiKey) {
      crawler.useCaptchaSolver(captchaProvider, captchaApiKey, {
        maxWaitMs: Number(options.captchaMaxWaitMs ?? 120000),
      });
    }
  }

  if (hints.signerLikely) {
    crawler.useReverseAnalysis({
      enabled: true,
      signerLikely: true,
    });
    crawler.setSigner({
      enabled: true,
      capture: {
        enabled: true,
        sources: ['responseBody', 'debugScripts'],
        maxScripts: Number(options.signerMaxScripts ?? 10),
      },
      inject: {
        enabled: false,
      },
    });
  }

  if (hints.appWebViewLikely) {
    const appType = hints.evidence?.appType ?? 'android';
    if (['wechat', 'douyin', 'taobao', 'jd', 'android', 'ios'].includes(appType)) {
      crawler.useAppWebView(appType, {
        userAgent: crawler._headers?.['user-agent'] ?? crawler._headers?.['User-Agent'],
      });
    }
  }

  if (hints.nativeAppLikely) {
    crawler.setReverseRuntime({
      enabled: true,
      app: {
        enabled: true,
        platform:
          hints.evidence?.appType === 'ios'
            ? 'ios'
            : 'android',
        sslPinning: {
          enabled: true,
          mode: 'advisory',
        },
      },
    });
  }

  return profile;
}

function classifyUniversalHtmlPageKind({ url = '', body = '' } = {}) {
  const normalizedUrl = String(url).toLowerCase();
  const normalizedBody = normalizeProbeBody(body).toLowerCase();
  const titleMatch = normalizedBody.match(/<title>([^<]+)<\/title>/i);
  const titleText = titleMatch?.[1]?.trim().toLowerCase() ?? '';

  const searchSignals = [
    /([?&](q|query|keyword|search)=)|\/search(\/|$)/i.test(normalizedUrl),
    /\b(search results|results for|found \d+|search)\b/i.test(titleText),
    /\b(search results|results for|load more results)\b/i.test(normalizedBody),
  ];
  if (searchSignals.some(Boolean)) {
    return 'search';
  }

  const listingSignals = [
    /([?&](category|cat|collection|tag|brand)=)|\/(category|categories|collection|collections|list|listing|catalog|catalogue|browse)(\/|$)/i.test(normalizedUrl),
    /\b(sort by|filter|filters|grid|results)\b/i.test(normalizedBody),
    /itemlist|collectionpage/i.test(normalizedBody),
  ];
  if (listingSignals.some(Boolean)) {
    return 'listing';
  }

  const detailSignals = [
    /\/(product|products|item|items|detail|details|dp)\/|\/p\/[a-z0-9_-]+/i.test(normalizedUrl),
    /\b(price|sku|add to cart|buy now|availability|out of stock)\b/i.test(normalizedBody),
    /product|offer|aggregateRating/i.test(normalizedBody),
  ];
  if (detailSignals.some(Boolean)) {
    return 'detail';
  }

  return 'generic';
}

export function detectUniversalSourceType(source = {}) {
  const url = String(source.url ?? '').toLowerCase();
  const headers = source.headers ?? {};
  const contentType = String(source.contentType ?? getHeaderIgnoreCase(headers, 'content-type') ?? '').toLowerCase();
  const body = normalizeProbeBody(source.body).trimStart().toLowerCase();

  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return 'websocket';
  }

  if (
    contentType.includes('rss')
    || contentType.includes('atom')
    || body.startsWith('<rss')
    || (body.startsWith('<?xml') && body.includes('<feed'))
    || body.includes('<feed')
  ) {
    return 'feed';
  }

  if (
    contentType.includes('xml')
    || url.includes('sitemap')
    || (body.startsWith('<?xml') && (body.includes('<urlset') || body.includes('<sitemapindex')))
    || body.includes('<urlset')
    || body.includes('<sitemapindex')
  ) {
    return 'sitemap';
  }

  if (contentType.includes('json') || body.startsWith('{') || body.startsWith('[')) {
    if (
      url.includes('/graphql')
      || contentType.includes('graphql')
      || body.includes('"__schema"')
      || body.includes('"errors"')
    ) {
      return 'graphql';
    }
    return 'json';
  }

  if (
    contentType.includes('html')
    || body.startsWith('<!doctype html')
    || body.startsWith('<html')
  ) {
    return 'html';
  }

  return 'binary';
}

function buildUniversalHeaders(kind) {
  switch (kind) {
    case 'feed':
      return {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
      };
    case 'sitemap':
      return {
        accept: 'application/xml, text/xml;q=0.9, */*;q=0.1',
      };
    case 'json':
    case 'graphql':
      return {
        accept: 'application/json, text/json;q=0.9, */*;q=0.1',
      };
    default:
      return {};
  }
}

function buildUniversalDiscovery(kind, options = {}) {
  const maxPages = options.maxPages ?? 200;
  const maxLinksPerPage = options.maxLinksPerPage ?? 200;
  const sameOriginOnly = options.sameOriginOnly ?? true;

  if (kind === 'feed') {
    return {
      enabled: true,
      maxPages,
      maxLinksPerPage,
      sameOriginOnly: false,
      extractor: {
        name: '__feed_links__',
        type: 'script',
        code: `
          const maxItems = ${Number(maxLinksPerPage) || 200};
          const rssLinks = [...body.matchAll(/<item\\b[\\s\\S]*?<link\\b[^>]*>([\\s\\S]*?)<\\/link>/gi)]
            .map((match) => match[1]?.trim())
            .filter(Boolean);
          const atomLinks = [...body.matchAll(/<entry\\b[\\s\\S]*?<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/gi)]
            .map((match) => match[1]?.trim())
            .filter(Boolean);
          return [...new Set([...rssLinks, ...atomLinks])].slice(0, maxItems);
        `,
      },
    };
  }

  if (kind === 'sitemap') {
    return {
      enabled: true,
      maxPages,
      maxLinksPerPage,
      sameOriginOnly: false,
      extractor: {
        name: '__sitemap_links__',
        type: 'xpath',
        xpath: '//url/loc/text() | //sitemap/loc/text()',
        all: true,
        xml: true,
        maxItems: maxLinksPerPage,
      },
    };
  }

  if (kind === 'html') {
    return {
      enabled: true,
      maxPages,
      maxLinksPerPage,
      sameOriginOnly,
      extractor: {
        name: '__links__',
        type: 'links',
        all: true,
        maxItems: maxLinksPerPage,
        selector: 'a[href], link[rel="next"][href], link[rel="canonical"][href], link[rel="alternate"][hreflang][href]',
        format: 'object',
      },
    };
  }

  return null;
}

function buildUniversalExtractRules(kind) {
  if (kind === 'html') {
    return [
      {
        name: 'title',
        type: 'selector',
        selector: 'title',
      },
      {
        name: 'h1',
        type: 'selector',
        selector: 'h1',
      },
      {
        name: 'canonicalUrl',
        type: 'selector',
        selector: 'link[rel="canonical"]',
        attribute: 'href',
      },
      {
        name: 'metaDescription',
        type: 'selector',
        selector: 'meta[name="description"], meta[property="og:description"]',
        attribute: 'content',
      },
      {
        name: 'lang',
        type: 'selector',
        selector: 'html',
        attribute: 'lang',
      },
      {
        name: 'jsonLd',
        type: 'script',
        code: `
          return [...body.matchAll(/<script[^>]*type=["']application\\/ld\\+json["'][^>]*>([\\s\\S]*?)<\\/script>/gi)]
            .map((match) => {
              try {
                return JSON.parse(match[1]);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        `,
      },
      {
        name: 'frontendSignals',
        type: 'script',
        code: `
          const lower = body.toLowerCase();
          const frameworks = [];
          const hydrationSources = [];
          const rootContainers = [];
          const addUnique = (list, value) => {
            if (value && !list.includes(value)) list.push(value);
          };

          if (/_next\\/static|id=["']__next["']|id=["']__next_data["']|__next_data__/i.test(lower)) addUnique(frameworks, 'nextjs');
          if (/_nuxt\\/|id=["']__nuxt["']|window\\.__nuxt__|__nuxt__/i.test(lower)) addUnique(frameworks, 'nuxt');
          if (/__remixcontext|remixmanifest|routemodules/i.test(lower)) addUnique(frameworks, 'remix');
          if (/window\\.__apollo_state__|apollo\\.restore\\(|__apollo_state__/i.test(lower)) addUnique(frameworks, 'apollo');
          if (/__preloaded_state__|__initial_state__|redux/i.test(lower)) addUnique(frameworks, 'redux');
          if (/\\/@vite\\/client|data-vite-dev-id|type=["']module["']/i.test(lower)) addUnique(frameworks, 'vite');
          if (/_app\\/immutable|data-sveltekit/i.test(lower)) addUnique(frameworks, 'sveltekit');

          if (/id=["']__next_data["']|__next_data__/i.test(lower)) addUnique(hydrationSources, '__NEXT_DATA__');
          if (/window\\.__nuxt__|__nuxt__/i.test(lower)) addUnique(hydrationSources, '__NUXT__');
          if (/window\\.__apollo_state__|__apollo_state__/i.test(lower)) addUnique(hydrationSources, '__APOLLO_STATE__');
          if (/__preloaded_state__/i.test(lower)) addUnique(hydrationSources, '__PRELOADED_STATE__');
          if (/__initial_state__/i.test(lower)) addUnique(hydrationSources, '__INITIAL_STATE__');

          for (const match of lower.matchAll(/id=["'](__next|__nuxt|app|root)["']/gi)) {
            addUnique(rootContainers, match[1]);
          }

          const visibleTextLength = body
            .replace(/<script\\b[^>]*>[\\s\\S]*?<\\/script>/gi, ' ')
            .replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style>/gi, ' ')
            .replace(/<noscript\\b[^>]*>[\\s\\S]*?<\\/noscript>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\\s+/g, ' ')
            .trim()
            .length;

          const scriptCount = (body.match(/<script\\b/gi) ?? []).length;
          const inlineScriptCount = (body.match(/<script(?![^>]+src=)[^>]*>/gi) ?? []).length;
          const appShellLikely = rootContainers.length > 0 && scriptCount >= 2 && visibleTextLength < 450;

          return {
            frameworks,
            hydrationSources,
            rootContainers,
            scriptCount,
            inlineScriptCount,
            visibleTextLength,
            appShellLikely,
          };
        `,
      },
      {
        name: 'hydrationData',
        type: 'script',
        code: `
          const parseJsonMaybe = (value) => {
            if (!value || typeof value !== 'string') return null;
            try {
              return JSON.parse(value);
            } catch {
              return value.trim();
            }
          };
          const findScriptById = (id) => {
            const doubleQuoteMarker = 'id="' + id + '"';
            const singleQuoteMarker = "id='" + id + "'";
            const markerIndex = body.indexOf(doubleQuoteMarker) >= 0
              ? body.indexOf(doubleQuoteMarker)
              : body.indexOf(singleQuoteMarker);
            if (markerIndex < 0) return null;
            const tagEndIndex = body.indexOf('>', markerIndex);
            if (tagEndIndex < 0) return null;
            const scriptEndIndex = body.indexOf('</script>', tagEndIndex);
            if (scriptEndIndex < 0) return null;
            return parseJsonMaybe(body.slice(tagEndIndex + 1, scriptEndIndex));
          };
          const findAssignment = (name) => {
            const markerIndex = body.indexOf(name);
            if (markerIndex < 0) return null;
            const equalsIndex = body.indexOf('=', markerIndex);
            if (equalsIndex < 0) return null;
            const scriptEndIndex = body.indexOf('</script>', equalsIndex);
            const candidate = body
              .slice(equalsIndex + 1, scriptEndIndex >= 0 ? scriptEndIndex : undefined)
              .trim()
              .replace(/;\\s*$/, '')
              .trim();
            return parseJsonMaybe(candidate);
          };
          return {
            nextData: findScriptById('__NEXT_DATA__'),
            nuxtData: findAssignment('__NUXT__'),
            apolloState: findAssignment('__APOLLO_STATE__'),
            initialState: findAssignment('__INITIAL_STATE__') ?? findAssignment('__PRELOADED_STATE__'),
          };
        `,
      },
    ];
  }

  if (kind === 'json' || kind === 'graphql') {
    return [
      {
        name: 'document',
        type: 'script',
        code: 'return json;',
      },
      {
        name: 'items',
        type: 'script',
        code: `
          if (!json || typeof json !== 'object') return [];
          const candidates = [json.items, json.results, json.records, json.data?.items, json.data?.results, json.data?.records];
          const firstArray = candidates.find((value) => Array.isArray(value));
          if (firstArray) return firstArray;
          return Array.isArray(json.data) ? json.data : [];
        `,
      },
      {
        name: 'nextCursor',
        type: 'script',
        code: `
          if (!json || typeof json !== 'object') return null;
          return json.nextCursor
            ?? json.cursor
            ?? json.pageInfo?.nextCursor
            ?? json.data?.pageInfo?.nextCursor
            ?? null;
        `,
      },
      {
        name: 'hasNextPage',
        type: 'script',
        code: `
          if (!json || typeof json !== 'object') return null;
          return json.hasNextPage
            ?? json.pageInfo?.hasNextPage
            ?? json.data?.pageInfo?.hasNextPage
            ?? null;
        `,
      },
    ];
  }

  if (kind === 'feed') {
    return [
      {
        name: 'items',
        type: 'script',
        code: 'return [...body.matchAll(/<item\\b[\\s\\S]*?<\\/item>|<entry\\b[\\s\\S]*?<\\/entry>/gi)].map((match) => match[0]);',
      },
      {
        name: 'titles',
        type: 'script',
        code: `
          const rss = [...body.matchAll(/<item\\b[\\s\\S]*?<title\\b[^>]*>([\\s\\S]*?)<\\/title>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atom = [...body.matchAll(/<entry\\b[\\s\\S]*?<title\\b[^>]*>([\\s\\S]*?)<\\/title>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          return [...rss, ...atom];
        `,
      },
      {
        name: 'links',
        type: 'script',
        code: `
          const rss = [...body.matchAll(/<item\\b[\\s\\S]*?<link\\b[^>]*>([\\s\\S]*?)<\\/link>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atom = [...body.matchAll(/<entry\\b[\\s\\S]*?<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          return [...new Set([...rss, ...atom])];
        `,
      },
    ];
  }

  if (kind === 'sitemap') {
    return [
      {
        name: 'urls',
        type: 'xpath',
        expression: '//url/loc/text()',
        xpath: '//url/loc/text()',
        all: true,
        xml: true,
        maxItems: 500,
      },
      {
        name: 'sitemaps',
        type: 'xpath',
        expression: '//sitemap/loc/text()',
        xpath: '//sitemap/loc/text()',
        all: true,
        xml: true,
        maxItems: 500,
      },
    ];
  }

  return null;
}

function buildUniversalHtmlProfile(url, body = '') {
  const pageKind = classifyUniversalHtmlPageKind({ url, body });
  const baseRules = buildUniversalExtractRules('html') ?? [];

  if (pageKind === 'detail') {
    return {
      pageKind,
      extractRules: [
        ...baseRules,
        {
          name: 'price',
          type: 'selector',
          selector: '[itemprop="price"], meta[property="product:price:amount"], .price, .product-price',
          attribute: 'content',
        },
        {
          name: 'sku',
          type: 'selector',
          selector: '[itemprop="sku"], [data-sku], .sku',
          attribute: 'content',
        },
        {
          name: 'availability',
          type: 'selector',
          selector: '[itemprop="availability"], .availability, .stock, link[itemprop="availability"]',
          attribute: 'href',
        },
        {
          name: 'brand',
          type: 'selector',
          selector: '[itemprop="brand"], meta[property="product:brand"], .brand, [data-brand]',
          attribute: 'content',
        },
        {
          name: 'rating',
          type: 'selector',
          selector: '[itemprop="ratingValue"], meta[property="og:rating"], .rating, .stars',
          attribute: 'content',
        },
        {
          name: 'reviewCount',
          type: 'selector',
          selector: '[itemprop="reviewCount"], [itemprop="ratingCount"], .review-count, .ratings-count',
          attribute: 'content',
        },
        {
          name: 'thumbnail',
          type: 'selector',
          selector: 'meta[property="og:image"], [itemprop="image"], img[itemprop="image"], .product-image img',
          attribute: 'content',
        },
        {
          name: 'snippet',
          type: 'selector',
          selector: 'meta[name="description"], meta[property="og:description"], .summary, .description, [itemprop="description"]',
          attribute: 'content',
        },
        {
          name: 'publishedAt',
          type: 'selector',
          selector: 'meta[property="article:published_time"], time[datetime], [itemprop="datePublished"]',
          attribute: 'content',
        },
        {
          name: 'author',
          type: 'selector',
          selector: 'meta[name="author"], [itemprop="author"], .author, .byline',
          attribute: 'content',
        },
      ],
    };
  }

  if (pageKind === 'listing' || pageKind === 'search') {
    return {
      pageKind,
      extractRules: [
        ...baseRules,
        {
          name: 'resultCards',
          type: 'script',
          code: `
            const parseJsonLd = () => {
              return [...body.matchAll(/<script[^>]*type=["']application\\/ld\\+json["'][^>]*>([\\s\\S]*?)<\\/script>/gi)]
                .flatMap((match) => {
                  try {
                    const parsed = JSON.parse(match[1]);
                    return Array.isArray(parsed) ? parsed : [parsed];
                  } catch {
                    return [];
                  }
                });
            };

            const asAbsolute = (value) => {
              try {
                return new URL(value, url).href;
              } catch {
                return null;
              }
            };

            const cards = [];
            const pushCard = (card) => {
              if (!card || !card.url || !card.title) return;
              if (cards.some((entry) => entry.url === card.url)) return;
              cards.push(card);
            };

            const jsonLd = parseJsonLd();
            for (const node of jsonLd) {
              const type = Array.isArray(node?.['@type']) ? node['@type'].join(',') : node?.['@type'];
              if (type === 'ItemList' && Array.isArray(node.itemListElement)) {
                for (const entry of node.itemListElement) {
                  const item = entry?.item ?? entry;
                  const offer = Array.isArray(item?.offers) ? item.offers[0] : item?.offers;
                  pushCard({
                    title: item?.name ?? null,
                    url: asAbsolute(item?.url ?? item?.['@id'] ?? entry?.url ?? null),
                    price: offer?.price ?? offer?.lowPrice ?? offer?.highPrice ?? null,
                    currency: offer?.priceCurrency ?? null,
                    image: Array.isArray(item?.image) ? item.image[0] : item?.image ?? null,
                    thumbnail: Array.isArray(item?.image) ? item.image[0] : item?.image ?? null,
                    brand: typeof item?.brand === 'string' ? item.brand : item?.brand?.name ?? null,
                    rating: item?.aggregateRating?.ratingValue ?? null,
                    reviewCount: item?.aggregateRating?.reviewCount ?? item?.aggregateRating?.ratingCount ?? null,
                    snippet: item?.description ?? null,
                    publishedAt: item?.datePublished ?? null,
                    author: typeof item?.author === 'string' ? item.author : item?.author?.name ?? null,
                    source: 'jsonld',
                  });
                }
              }

              if (type === 'Product') {
                const offer = Array.isArray(node?.offers) ? node.offers[0] : node?.offers;
                pushCard({
                  title: node?.name ?? null,
                  url: asAbsolute(node?.url ?? node?.['@id'] ?? null),
                  price: offer?.price ?? offer?.lowPrice ?? offer?.highPrice ?? null,
                  currency: offer?.priceCurrency ?? null,
                  image: Array.isArray(node?.image) ? node.image[0] : node?.image ?? null,
                  thumbnail: Array.isArray(node?.image) ? node.image[0] : node?.image ?? null,
                  brand: typeof node?.brand === 'string' ? node.brand : node?.brand?.name ?? null,
                  rating: node?.aggregateRating?.ratingValue ?? null,
                  reviewCount: node?.aggregateRating?.reviewCount ?? node?.aggregateRating?.ratingCount ?? null,
                  snippet: node?.description ?? null,
                  publishedAt: node?.datePublished ?? null,
                  author: typeof node?.author === 'string' ? node.author : node?.author?.name ?? null,
                  source: 'jsonld',
                });
              }
            }

            const anchorRe = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\\s\\S]*?)<\\/a>/gi;
            let match;
            while ((match = anchorRe.exec(body)) !== null && cards.length < 24) {
              const cardUrl = asAbsolute(match[1]);
              const anchorHtml = match[0];
              const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
              if (!cardUrl || !title || title.length < 2) continue;
              if (/^(sign in|log in|next|previous|more|load more)$/i.test(title)) continue;
              if (/\\/search|\\/category|\\/cart|\\/login|\\/account/i.test(cardUrl) && !/\\?q=|\\/product|\\/item|\\/p\\//i.test(cardUrl)) continue;

              const nearby = body.slice(match.index, match.index + 600);
              const priceMatch = nearby.match(/(?:[$€£¥]|USD\\s*|EUR\\s*|GBP\\s*|CNY\\s*)(\\d[\\d,.]*)/i);
              const imageMatch = nearby.match(/<img[^>]+src=["']([^"']+)["']/i);
              const ratingMatch = nearby.match(/([0-5](?:\\.\\d)?)\\s*(?:out of 5|\\/5|stars?)/i);
              const reviewCountMatch = nearby.match(/(\\d[\\d,.]*)\\s*(?:reviews?|ratings?)/i);
              const brandMatch = nearby.match(/<[^>]+class=["'][^"']*brand[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>/i);
              const snippetText = nearby
                .replace(/<img[^>]*>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\\s+/g, ' ')
                .trim();
              const dateMatch = nearby.match(/\\b(20\\d{2}-\\d{2}-\\d{2}|20\\d{2}\\/\\d{2}\\/\\d{2}|\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[^\\s<]*)\\b/);
              const authorMatch = nearby.match(/(?:by|author[:\\s]+)\\s*([A-Z][A-Za-z .'-]{2,40})/i);

              pushCard({
                title,
                url: cardUrl,
                price: priceMatch?.[1] ?? null,
                currency: priceMatch ? priceMatch[0].replace(priceMatch[1], '').trim() || null : null,
                image: imageMatch ? asAbsolute(imageMatch[1]) : null,
                thumbnail: imageMatch ? asAbsolute(imageMatch[1]) : null,
                brand: brandMatch ? brandMatch[1].replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim() : null,
                rating: ratingMatch?.[1] ?? null,
                reviewCount: reviewCountMatch?.[1] ?? null,
                snippet: snippetText && snippetText !== title ? snippetText.slice(0, 220) : null,
                publishedAt: dateMatch?.[1] ?? null,
                author: authorMatch?.[1] ?? null,
                source: 'html',
              });
            }

            return cards;
          `,
        },
        {
          name: 'resultLinks',
          type: 'links',
          selector: 'a[href]',
          format: 'object',
          all: true,
          maxItems: 50,
        },
        {
          name: 'paginationLinks',
          type: 'links',
          selector: 'a[rel="next"][href], .pagination a[href], nav[aria-label*="pagination" i] a[href]',
          format: 'object',
          all: true,
          maxItems: 20,
        },
      ],
    };
  }

  return {
    pageKind,
    extractRules: baseRules,
  };
}

function buildUniversalNetworkExtractRules({ frontend = null, strategyHints = null } = {}) {
  const shouldInclude = Boolean(
    frontend?.requiresBrowser
    || frontend?.appShellLikely
    || strategyHints?.browserShellLikely
    || (Array.isArray(frontend?.frameworks) && frontend.frameworks.length > 0),
  );

  if (!shouldInclude) {
    return [];
  }

  return [
    {
      name: 'networkPayloads',
      type: 'network',
      transports: ['fetch', 'xhr'],
      selection: 'payload',
      all: true,
      includeMeta: true,
      requireJson: true,
      maxItems: 12,
    },
    {
      name: 'networkPrimaryData',
      type: 'network',
      transports: ['fetch', 'xhr'],
      selection: 'primary-data',
      requireJson: true,
      maxItems: 1,
    },
  ];
}

function resolveUniversalMode(kind, options = {}, frontend = null) {
  if (kind === 'feed' || kind === 'sitemap') {
    return 'cheerio';
  }
  if (kind === 'json' || kind === 'graphql') {
    return 'http';
  }
  if (kind === 'html') {
    return options.preferBrowser === true || frontend?.requiresBrowser ? 'browser' : 'hybrid';
  }
  return 'http';
}

export function inferUniversalSourceProfile(source = {}, options = {}) {
  const url = String(source.finalUrl ?? source.url ?? '');
  const headers = source.headers ?? {};
  const body = normalizeProbeBody(source.body);
  const kind = detectUniversalSourceType({
    ...source,
    url,
    headers,
    body,
  });
  const graphqlEndpoints = kind === 'html' ? detectGraphQLEndpoints(body, url) : [];
  const htmlProfile = kind === 'html' ? buildUniversalHtmlProfile(url, body) : null;
  const frontend = kind === 'html' ? detectUniversalFrontendSignals({ url, body }) : null;
  const scroll = kind === 'html'
    ? detectUniversalScrollSignals({
        body,
        pageKind: htmlProfile?.pageKind ?? null,
        frontend,
      })
    : null;
  const strategyHints = buildUniversalStrategyHints({
    url,
    headers,
    body,
    kind,
    frontend,
    graphqlEndpoints,
  });
  const recommendedPreset =
    kind === 'feed'
      ? 'FeedCrawler'
      : kind === 'sitemap'
        ? 'SitemapCrawler'
        : kind === 'graphql'
          ? 'GraphQLCrawler'
          : kind === 'websocket'
            ? 'WebSocketCrawler'
            : 'UniversalCrawler';
  const supportedByUniversal = kind !== 'websocket' && kind !== 'binary';

  return {
    url,
    kind,
    pageKind: htmlProfile?.pageKind ?? null,
    mode: resolveUniversalMode(kind, options, frontend),
    recommendedPreset,
    supportedByUniversal,
    unsupportedReason:
      kind === 'websocket'
        ? 'WebSocket targets still need protocol-specific subscribe messages and heartbeat handling.'
        : kind === 'binary'
          ? 'Binary or opaque targets still need protocol-specific reverse engineering or a custom fetcher.'
          : null,
    headers: buildUniversalHeaders(kind),
    discovery: buildUniversalDiscovery(kind, options),
    extractRules: htmlProfile
      ? [
          ...htmlProfile.extractRules,
          ...buildUniversalNetworkExtractRules({ frontend, strategyHints }),
        ]
      : buildUniversalExtractRules(kind),
    graphqlEndpoints,
    frontend,
    scroll,
    strategyHints,
    contentType: String(source.contentType ?? getHeaderIgnoreCase(headers, 'content-type') ?? ''),
  };
}

export class JSDOMCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: 'http',
    });
  }

  setXPathRules(rules = []) {
    return this.setExtractRules(rules.map((rule) => ({
      ...rule,
      type: 'xpath',
      xpath: rule.xpath ?? rule.expression,
    })));
  }

  setXPathMap(fieldMap = {}, options = {}) {
    return this.setXPathRules(buildXPathRules(fieldMap, options));
  }
}

export class ApiJsonCrawler extends OmniCrawler {
  constructor(config = {}) {
    super(withMergedHeaders({
      ...config,
      mode: 'http',
    }, {
      accept: 'application/json, text/json;q=0.9, */*;q=0.1',
    }));
  }

  setJsonPathMap(fieldMap = {}) {
    return this.setExtractRules(buildJsonPathRules(fieldMap));
  }
}

export class FeedCrawler extends OmniCrawler {
  constructor(config = {}) {
    super(withMergedHeaders({
      ...config,
      mode: 'cheerio',
    }, {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
    }));

    this.setDiscovery({
      enabled: true,
      maxPages: config.maxPages ?? 100,
      maxLinksPerPage: config.maxLinksPerPage ?? 100,
      sameOriginOnly: config.sameOriginOnly ?? false,
      extractor: {
        name: '__feed_links__',
        type: 'script',
        code: `
          const maxItems = ${Number(config.maxLinksPerPage ?? 100) || 100};
          const rssLinks = [...body.matchAll(/<item\\b[\\s\\S]*?<link\\b[^>]*>([\\s\\S]*?)<\\/link>/gi)]
            .map((match) => match[1]?.trim())
            .filter(Boolean);
          const atomLinks = [...body.matchAll(/<entry\\b[\\s\\S]*?<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/gi)]
            .map((match) => match[1]?.trim())
            .filter(Boolean);
          return [...new Set([...rssLinks, ...atomLinks])].slice(0, maxItems);
        `,
      },
    });
  }

  useFeedExtraction(overrides = {}) {
    if (Object.keys(overrides).length > 0) {
      const defaults = {
        items: '//item | //entry',
        titles: '//item/title/text() | //entry/title/text()',
        links: '//item/link/text() | //entry/link/@href | //entry/link/text()',
        descriptions: '//item/description/text() | //entry/summary/text() | //entry/content/text()',
        publishedAt: '//item/pubDate/text() | //entry/published/text() | //entry/updated/text()',
      };

      return this.setExtractRules(buildXPathRules({
        ...defaults,
        ...overrides,
      }, {
        all: true,
        xml: true,
      }));
    }

    return this.setExtractRules([
      {
        name: 'items',
        type: 'script',
        code: 'return [...body.matchAll(/<item\\b[\\s\\S]*?<\\/item>|<entry\\b[\\s\\S]*?<\\/entry>/gi)].map((match) => match[0]);',
      },
      {
        name: 'titles',
        type: 'script',
        code: `
          const rss = [...body.matchAll(/<item\\b[\\s\\S]*?<title\\b[^>]*>([\\s\\S]*?)<\\/title>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atom = [...body.matchAll(/<entry\\b[\\s\\S]*?<title\\b[^>]*>([\\s\\S]*?)<\\/title>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          return [...rss, ...atom];
        `,
      },
      {
        name: 'links',
        type: 'script',
        code: `
          const rss = [...body.matchAll(/<item\\b[\\s\\S]*?<link\\b[^>]*>([\\s\\S]*?)<\\/link>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atom = [...body.matchAll(/<entry\\b[\\s\\S]*?<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          return [...new Set([...rss, ...atom])];
        `,
      },
      {
        name: 'descriptions',
        type: 'script',
        code: `
          const rss = [...body.matchAll(/<item\\b[\\s\\S]*?<description\\b[^>]*>([\\s\\S]*?)<\\/description>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atomSummary = [...body.matchAll(/<entry\\b[\\s\\S]*?<summary\\b[^>]*>([\\s\\S]*?)<\\/summary>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atomContent = [...body.matchAll(/<entry\\b[\\s\\S]*?<content\\b[^>]*>([\\s\\S]*?)<\\/content>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          return [...rss, ...atomSummary, ...atomContent];
        `,
      },
      {
        name: 'publishedAt',
        type: 'script',
        code: `
          const rss = [...body.matchAll(/<item\\b[\\s\\S]*?<pubDate\\b[^>]*>([\\s\\S]*?)<\\/pubDate>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atomPublished = [...body.matchAll(/<entry\\b[\\s\\S]*?<published\\b[^>]*>([\\s\\S]*?)<\\/published>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          const atomUpdated = [...body.matchAll(/<entry\\b[\\s\\S]*?<updated\\b[^>]*>([\\s\\S]*?)<\\/updated>/gi)].map((match) => match[1]?.trim()).filter(Boolean);
          return [...rss, ...atomPublished, ...atomUpdated];
        `,
      },
    ]);
  }
}

export class SitemapCrawler extends OmniCrawler {
  constructor(config = {}) {
    super(withMergedHeaders({
      ...config,
      mode: 'cheerio',
    }, {
      accept: 'application/xml, text/xml;q=0.9, */*;q=0.1',
    }));

    this.useSitemapExtraction({
      includeChildSitemaps: config.includeChildSitemaps !== false,
    });
    this.setDiscovery({
      enabled: true,
      maxPages: config.maxPages ?? 500,
      maxLinksPerPage: config.maxLinksPerPage ?? 500,
      sameOriginOnly: config.sameOriginOnly ?? false,
      extractor: {
        name: '__sitemap_links__',
        type: 'xpath',
        xpath: '//url/loc/text() | //sitemap/loc/text()',
        all: true,
        xml: true,
        maxItems: config.maxLinksPerPage ?? 500,
      },
    });
  }

  useSitemapExtraction({ includeChildSitemaps = true } = {}) {
    const rules = [
      {
        name: 'urls',
        type: 'xpath',
        expression: '//url/loc/text()',
        xpath: '//url/loc/text()',
        all: true,
        xml: true,
        maxItems: 500,
      },
    ];

    if (includeChildSitemaps) {
      rules.push({
        name: 'sitemaps',
        type: 'xpath',
        expression: '//sitemap/loc/text()',
        xpath: '//sitemap/loc/text()',
        all: true,
        xml: true,
        maxItems: 500,
      });
    }

    return this.setExtractRules(rules);
  }
}

export class GraphQLCrawler extends ApiJsonCrawler {
  constructor(config = {}) {
    super(withMergedHeaders(config, {
      'content-type': 'application/json',
    }));
  }

  detectEndpoints(source, baseUrl) {
    return detectGraphQLEndpoints(source, baseUrl);
  }

  detectPersistedQueries(source, baseUrl) {
    return extractPersistedQueryHints(source, baseUrl);
  }

  execute(options = {}) {
    return executeGraphQL({
      headers: {
        ...(this._headers ?? {}),
        ...(options.headers ?? {}),
      },
      timeoutMs: this._timeoutMs,
      ...options,
    });
  }

  introspect(endpoint, options = {}) {
    return introspectSchema(endpoint, {
      headers: {
        ...(this._headers ?? {}),
        ...(options.headers ?? {}),
      },
      timeoutMs: this._timeoutMs,
      ...options,
    });
  }

  buildStarterOperation(schema, options = {}) {
    return buildGraphQLStarterOperation(schema, options);
  }

  buildRequestPlan(source, baseUrl, schema = null, options = {}) {
    return buildGraphQLRequestPlan({
      source,
      baseUrl,
      schema,
      endpoint: options.endpoint,
      maxDepth: options.maxDepth,
      maxFields: options.maxFields,
    });
  }

  fetchAllPages(options = {}) {
    return fetchAllGraphQLPages({
      headers: {
        ...(this._headers ?? {}),
        ...(options.headers ?? {}),
      },
      ...options,
    });
  }
}

export class UniversalCrawler extends OmniCrawler {
  constructor(config = {}) {
    super({
      ...config,
      mode: config.mode ?? 'hybrid',
    });

    this._universalConfig = {
      preferBrowser: config.preferBrowser === true,
      maxPages: config.maxPages ?? 200,
      maxLinksPerPage: config.maxLinksPerPage ?? 200,
      sameOriginOnly: config.sameOriginOnly ?? true,
    };
  }

  static inferSourceProfile(source = {}, options = {}) {
    return inferUniversalSourceProfile(source, options);
  }

  configureSource(source = {}, options = {}) {
    const profile = source?.kind
      ? source
      : inferUniversalSourceProfile(source, {
          ...this._universalConfig,
          ...options,
        });

    if (profile.mode) {
      this.setMode(profile.mode);
    }
    if (profile.headers && Object.keys(profile.headers).length > 0) {
      this.setHeaders(profile.headers);
    }
    if (profile.discovery) {
      this.setDiscovery(profile.discovery);
    }
    if (profile.extractRules) {
      this.setExtractRules(profile.extractRules);
    }

    return applyUniversalStrategy(this, profile, options);
  }

  async analyzeTarget(url, options = {}) {
    const response = await fetchWithHttp({
      url,
      method: options.method ?? 'GET',
      headers: {
        ...(this._headers ?? {}),
        ...(options.headers ?? {}),
      },
      timeoutMs: options.timeoutMs ?? this._timeoutMs,
    });

    return inferUniversalSourceProfile({
      ...response,
      url: response.finalUrl ?? url,
    }, {
      ...this._universalConfig,
      ...options,
    });
  }

  async prepareTarget(url, options = {}) {
    const profile = await this.analyzeTarget(url, options);
    this.configureSource(profile, options);

    if (!this._seedRequests.some((entry) => entry.url === url)) {
      this.addSeedUrls(url);
    }

    return profile;
  }
}

export class WebSocketCrawler extends HttpCrawler {
  constructor(config = {}) {
    super(config);
    this._webSocketOptions = {};
  }

  setWebSocketOptions(options = {}) {
    this._webSocketOptions = {
      ...this._webSocketOptions,
      ...options,
    };
    this._workflowOverrides.websocket = {
      ...(this._workflowOverrides.websocket ?? {}),
      ...this._webSocketOptions,
    };
    return this;
  }

  connect(options = {}) {
    return fetchWebSocket({
      headers: {
        ...(this._headers ?? {}),
        ...(this._webSocketOptions.headers ?? {}),
        ...(options.headers ?? {}),
      },
      connectTimeoutMs: this._timeoutMs,
      ...this._webSocketOptions,
      ...options,
    });
  }

  subscribe(url, subscribeMessage, options = {}) {
    return subscribeWebSocket(url, subscribeMessage, {
      headers: {
        ...(this._headers ?? {}),
        ...(this._webSocketOptions.headers ?? {}),
        ...(options.headers ?? {}),
      },
      connectTimeoutMs: this._timeoutMs,
      ...this._webSocketOptions,
      ...options,
    });
  }

  analyzeTranscript(transcript = [], options = {}) {
    return analyzeWebSocketTranscript(transcript, options);
  }

  buildSessionPlan(transcript = [], options = {}) {
    return buildWebSocketSessionPlan(transcript, options);
  }
}
