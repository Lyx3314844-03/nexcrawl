function toPositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

function slugifyValue(value, fallback = 'quick-start') {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || fallback;
}

export const workflowTemplateCatalog = [
  {
    id: 'static',
    title: 'Static Page',
    description: 'Static HTML pages such as articles, list pages, and company sites.',
    defaults: {
      sourceType: 'static-page',
      extractPreset: 'title-links',
      maxDepth: 1,
      maxPages: 20,
      renderWaitMs: 0,
    },
  },
  {
    id: 'browser',
    title: 'Browser Rendered',
    description: 'JavaScript-rendered pages that need a browser runtime.',
    defaults: {
      sourceType: 'browser-rendered',
      extractPreset: 'article',
      maxDepth: 0,
      maxPages: 10,
      renderWaitMs: 1200,
    },
  },
  {
    id: 'api',
    title: 'JSON API',
    description: 'JSON endpoints that return structured API payloads.',
    defaults: {
      sourceType: 'api-json',
      extractPreset: 'json-payload',
      maxDepth: 0,
      maxPages: 5,
      renderWaitMs: 0,
    },
  },
  {
    id: 'sitemap',
    title: 'Sitemap / Feed',
    description: 'Sitemap, RSS, and Atom feeds for URL discovery.',
    defaults: {
      sourceType: 'sitemap',
      extractPreset: 'title-links',
      maxDepth: 0,
      maxPages: 50,
      renderWaitMs: 0,
    },
  },
];

export function getWorkflowTemplateCatalog() {
  return workflowTemplateCatalog.map((entry) => ({ ...entry }));
}

export function buildExtractRules({ sourceType = 'static-page', extractPreset = 'title-links' } = {}) {
  if (sourceType === 'api-json') {
    return [
      { name: 'payload', type: 'script', code: 'return json;' },
    ];
  }

  if (sourceType === 'sitemap') {
    return [
      { name: 'urls', type: 'xpath', xpath: '//url/loc/text()', all: true, xml: true, maxItems: 500 },
      { name: 'sitemaps', type: 'xpath', xpath: '//sitemap/loc/text()', all: true, xml: true, maxItems: 500 },
    ];
  }

  if (sourceType === 'feed') {
    return [
      {
        name: 'titles',
        type: 'xpath',
        xpath: '//*[local-name()="item"]/*[local-name()="title"]/text() | //*[local-name()="entry"]/*[local-name()="title"]/text()',
        all: true,
        xml: true,
        maxItems: 100,
      },
      {
        name: 'links',
        type: 'xpath',
        xpath: '//*[local-name()="item"]/*[local-name()="link"]/text() | //*[local-name()="entry"]/*[local-name()="link"]/@href',
        all: true,
        xml: true,
        maxItems: 100,
      },
    ];
  }

  if (extractPreset === 'article') {
    return [
      { name: 'title', type: 'selector', selector: 'title' },
      { name: 'headline', type: 'selector', selector: 'h1' },
      { name: 'summary', type: 'selector', selector: 'meta[name="description"]', attribute: 'content' },
      { name: 'surface', type: 'surface' },
    ];
  }

  if (extractPreset === 'surface') {
    return [
      { name: 'title', type: 'selector', selector: 'title' },
      { name: 'surface', type: 'surface' },
    ];
  }

  return [
    { name: 'title', type: 'selector', selector: 'title' },
    { name: 'links', type: 'links', selector: 'a[href]', all: true, maxItems: 50 },
    { name: 'surface', type: 'surface' },
  ];
}

export function buildWorkflowFromTemplate(input = {}) {
  const sourceType = String(input.sourceType ?? 'static-page');
  const extractPreset = String(input.extractPreset ?? 'title-links');
  const taskName = String(input.taskName ?? 'quick-start').trim() || 'quick-start';
  const seedUrl = String(input.seedUrl ?? '').trim();
  if (!seedUrl) {
    throw new Error('seedUrl is required');
  }

  const maxDepth = toPositiveInt(input.maxDepth, 0, 0, 3);
  const maxPages = toPositiveInt(input.maxPages, 20, 1, 200);
  const renderWaitMs = toPositiveInt(input.renderWaitMs, 800, 0, 10000);
  const useSession = input.useSession !== false;
  const useBrowserDebug = input.useBrowserDebug !== false;
  const persistBodies = input.persistBodies === true;

  const workflow = {
    name: taskName,
    seedUrls: [seedUrl],
    mode: sourceType === 'browser-rendered' ? 'browser' : (sourceType === 'static-page' ? 'cheerio' : 'http'),
    concurrency: 1,
    maxDepth: sourceType === 'api-json' || sourceType === 'sitemap' || sourceType === 'feed' ? 0 : maxDepth,
    headers: {},
    extract: buildExtractRules({ sourceType, extractPreset }),
    plugins: [{ name: 'dedupe' }, { name: 'audit' }],
    output: {
      dir: 'runs',
      persistBodies,
      console: false,
    },
  };

  if (useSession) {
    workflow.session = {
      enabled: true,
      scope: 'job',
    };
  }

  if (sourceType === 'browser-rendered') {
    workflow.browser = {
      headless: true,
      waitUntil: 'networkidle2',
      sleepMs: renderWaitMs,
      debug: useBrowserDebug
        ? {
            enabled: true,
            persistArtifacts: true,
          }
        : {
            enabled: false,
          },
    };
  }

  if (sourceType === 'api-json') {
    workflow.headers.accept = 'application/json, text/plain;q=0.9, */*;q=0.8';
  }

  if (sourceType === 'sitemap' || sourceType === 'feed') {
    workflow.headers.accept = 'application/xml, text/xml;q=0.9, application/rss+xml;q=0.9, application/atom+xml;q=0.9, */*;q=0.8';
  }

  if (workflow.maxDepth > 0 || sourceType === 'api-json' || sourceType === 'sitemap' || sourceType === 'feed') {
    workflow.discovery = {
      enabled: true,
      maxPages,
      maxLinksPerPage: sourceType === 'sitemap' ? 10000 : sourceType === 'feed' ? 100 : 50,
      sameOriginOnly: sourceType === 'sitemap' || sourceType === 'feed' ? false : true,
      exclude: ['\\.(jpg|jpeg|png|gif|svg|webp|css|js|woff2?|ico|pdf)(\\?.*)?$'],
      extractor: sourceType === 'sitemap'
        ? {
              name: 'discover',
              type: 'xpath',
              xpath: '//url/loc/text() | //sitemap/loc/text()',
              all: true,
              xml: true,
              maxItems: 500,
            }
        : sourceType === 'feed'
          ? {
              name: 'discover',
              type: 'script',
              code: `
                const maxItems = 100;
                const rssLinks = [...body.matchAll(/<item\\b[\\s\\S]*?<link\\b[^>]*>([\\s\\S]*?)<\\/link>/gi)]
                  .map((match) => match[1]?.trim())
                  .filter(Boolean);
                const atomLinks = [...body.matchAll(/<entry\\b[\\s\\S]*?<link\\b[^>]*href=["']([^"']+)["'][^>]*\\/?>(?:<\\/link>)?/gi)]
                  .map((match) => match[1]?.trim())
                  .filter(Boolean);
                return [...new Set([...rssLinks, ...atomLinks])].slice(0, maxItems);
              `,
            }
          : {
              name: 'discover',
              type: 'links',
              selector: 'a[href]',
              all: true,
              maxItems: 50,
            },
    };
  }

  return {
    workflow,
    suggestedWorkflowId: slugifyValue(input.workflowId || workflow.name),
    template: {
      sourceType,
      extractPreset,
    },
  };
}

export function buildPreviewWorkflow({
  url,
  sourceType = 'static-page',
  renderWaitMs = 800,
  rule,
} = {}) {
  if (!url) {
    throw new Error('url is required');
  }
  if (!rule || typeof rule !== 'object') {
    throw new Error('rule is required');
  }

  const workflow = buildWorkflowFromTemplate({
    taskName: 'extract-preview',
    seedUrl: url,
    sourceType,
    extractPreset: 'surface',
    renderWaitMs,
    useSession: false,
    useBrowserDebug: sourceType === 'browser-rendered',
    persistBodies: false,
    maxDepth: 0,
    maxPages: 1,
  }).workflow;

  workflow.name = 'extract-preview';
  workflow.extract = [{
    name: rule.name ?? 'preview',
    ...rule,
  }];
  workflow.output.dir = 'runs/previews';
  return workflow;
}
