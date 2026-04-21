import { OmniCrawler } from './omnicrawler.js';
import {
  detectGraphQLEndpoints,
  executeGraphQL,
  introspectSchema,
  fetchAllPages as fetchAllGraphQLPages,
} from '../fetchers/graphql-fetcher.js';
import { fetchWebSocket, subscribeWebSocket } from '../fetchers/ws-fetcher.js';

function mergeBrowserConfig(config = {}, browser = {}) {
  return {
    ...(config.browser ?? {}),
    ...browser,
  };
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
}
