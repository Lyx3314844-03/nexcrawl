import { setTimeout as sleep } from 'node:timers/promises';
import { fetchWithHttp } from '../fetchers/http-fetcher.js';

function normalizeUserAgent(value) {
  const normalized = String(value ?? '*').trim().toLowerCase();
  return normalized || '*';
}

function stripInlineComment(line) {
  const hashIndex = line.indexOf('#');
  return (hashIndex >= 0 ? line.slice(0, hashIndex) : line).trim();
}

function matchesUserAgent(candidate, userAgent) {
  const normalizedCandidate = normalizeUserAgent(candidate);
  if (normalizedCandidate === '*') {
    return true;
  }

  return userAgent.includes(normalizedCandidate);
}

export function parseRobotsTxt(text = '') {
  const groups = [];
  let currentGroup = {
    userAgents: [],
    rules: [],
    crawlDelaySeconds: null,
  };
  const sitemapUrls = new Set();
  let hasDirectives = false;

  const flushGroup = () => {
    if (currentGroup.userAgents.length > 0 || currentGroup.rules.length > 0 || currentGroup.crawlDelaySeconds !== null) {
      groups.push(currentGroup);
    }

    currentGroup = {
      userAgents: [],
      rules: [],
      crawlDelaySeconds: null,
    };
    hasDirectives = false;
  };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = stripInlineComment(rawLine);
    if (!line) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex < 0) {
      continue;
    }

    const directive = line.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = line.slice(separatorIndex + 1).trim();

    if (directive === 'user-agent') {
      if (hasDirectives) {
        flushGroup();
      }
      currentGroup.userAgents.push(normalizeUserAgent(rawValue));
      continue;
    }

    if (directive === 'allow' || directive === 'disallow') {
      hasDirectives = true;
      if (rawValue) {
        currentGroup.rules.push({
          directive,
          pattern: rawValue,
        });
      }
      continue;
    }

    if (directive === 'crawl-delay') {
      hasDirectives = true;
      const parsed = Number.parseFloat(rawValue);
      if (Number.isFinite(parsed) && parsed >= 0) {
        currentGroup.crawlDelaySeconds = parsed;
      }
      continue;
    }

    if (directive === 'sitemap' && rawValue) {
      sitemapUrls.add(rawValue);
    }
  }

  flushGroup();

  return {
    groups,
    sitemapUrls: [...sitemapUrls],
  };
}

function selectRobotsGroups(parsed, userAgent) {
  const exact = [];
  const wildcard = [];

  for (const group of parsed.groups) {
    if (group.userAgents.some((candidate) => candidate !== '*' && matchesUserAgent(candidate, userAgent))) {
      exact.push(group);
      continue;
    }

    if (group.userAgents.includes('*')) {
      wildcard.push(group);
    }
  }

  return exact.length > 0 ? exact : wildcard;
}

function resolveRobotsRules(parsed, userAgent) {
  const matchedGroups = selectRobotsGroups(parsed, userAgent);

  return {
    rules: matchedGroups.flatMap((group) => group.rules),
    crawlDelaySeconds: matchedGroups.reduce((maxDelay, group) => {
      if (group.crawlDelaySeconds === null) {
        return maxDelay;
      }

      return Math.max(maxDelay, group.crawlDelaySeconds);
    }, 0),
    sitemapUrls: parsed.sitemapUrls,
  };
}

function getMatchLength(pattern, targetPath) {
  if (!pattern) {
    return -1;
  }

  const wildcardIndex = pattern.indexOf('*');
  const normalizedPattern = wildcardIndex >= 0 ? pattern.slice(0, wildcardIndex) : pattern;

  if (!targetPath.startsWith(normalizedPattern)) {
    return -1;
  }

  return normalizedPattern.length;
}

export function evaluateRobotsAccess(url, rules = []) {
  const parsedUrl = new URL(url);
  const targetPath = `${parsedUrl.pathname}${parsedUrl.search}`;
  let bestRule = null;

  for (const rule of rules) {
    const matchLength = getMatchLength(rule.pattern, targetPath);
    if (matchLength < 0) {
      continue;
    }

    if (
      !bestRule ||
      matchLength > bestRule.matchLength ||
      (matchLength === bestRule.matchLength && rule.directive === 'allow' && bestRule.directive === 'disallow')
    ) {
      bestRule = {
        ...rule,
        matchLength,
      };
    }
  }

  return {
    allowed: !bestRule || bestRule.directive !== 'disallow',
    matchedRule: bestRule
      ? {
          directive: bestRule.directive,
          pattern: bestRule.pattern,
          matchLength: bestRule.matchLength,
        }
      : null,
  };
}

function decodeXmlEntities(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'');
}

function extractXmlLocations(xmlText) {
  return [...String(xmlText).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => decodeXmlEntities(match[1]).trim())
    .filter(Boolean);
}

function parseSitemapDocument(xmlText) {
  const locations = extractXmlLocations(xmlText);
  return {
    type: /<sitemapindex\b/i.test(xmlText) ? 'index' : 'urlset',
    locations,
  };
}

function uniqueOrigins(urls = []) {
  const origins = new Set();
  for (const value of urls) {
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Ignore invalid seed urls here. Schema validation handles workflow input.
    }
  }
  return [...origins];
}

function buildRobotsUrl(origin) {
  return new URL('/robots.txt', origin).href;
}

export class CrawlPolicyManager {
  constructor({ workflow, logger, proxyPool } = {}) {
    this.workflow = workflow ?? {};
    this.logger = logger;
    this.proxyPool = proxyPool ?? null;
    this.config = this.workflow.crawlPolicy?.robotsTxt ?? {};
    this.userAgent = normalizeUserAgent(
      this.config.userAgent
        ?? this.workflow.headers?.['user-agent']
        ?? this.workflow.headers?.['User-Agent']
        ?? '*',
    );
    this.records = new Map();
    this.pendingLoads = new Map();
    this.hostReservations = new Map();
    this.nextAvailableAt = new Map();
    this.stats = {
      enabled: this.isEnabled(),
      userAgent: this.userAgent,
      originsSeen: 0,
      robotsFetchCount: 0,
      robotsAllowedOnErrorCount: 0,
      robotsBlockedCount: 0,
      sitemapFetchCount: 0,
      sitemapUrlsDiscovered: 0,
      sitemapUrlsEnqueued: 0,
      proxiedPolicyFetchCount: 0,
      directPolicyFetchCount: 0,
      policyProxyFailureCount: 0,
      totalDelayMs: 0,
    };
  }

  isEnabled() {
    return this.config.enabled === true;
  }

  snapshot() {
    return {
      ...this.stats,
    };
  }

  async evaluateUrl(url) {
    if (!this.isEnabled()) {
      return { allowed: true, source: 'disabled' };
    }

    const record = await this.loadOriginRecord(url);
    if (record.loadError) {
      if (this.config.allowOnError !== false) {
        this.stats.robotsAllowedOnErrorCount += 1;
        return {
          allowed: true,
          source: 'robots-unavailable',
          error: record.loadError,
        };
      }

      return {
        allowed: false,
        source: 'robots-unavailable',
        error: record.loadError,
        matchedRule: null,
        userAgent: this.userAgent,
      };
    }

    const decision = evaluateRobotsAccess(url, record.rules);
    if (!decision.allowed) {
      this.stats.robotsBlockedCount += 1;
    }

    return {
      ...decision,
      source: record.loadError ? 'robots-unavailable' : 'robots-txt',
      userAgent: this.userAgent,
    };
  }

  async waitForTurn(url) {
    if (!this.isEnabled() || this.config.respectCrawlDelay === false) {
      return { waitMs: 0, crawlDelayMs: 0 };
    }

    const record = await this.loadOriginRecord(url);
    const crawlDelayMs = record.crawlDelayMs ?? 0;
    if (crawlDelayMs <= 0) {
      return { waitMs: 0, crawlDelayMs: 0 };
    }

    const origin = new URL(url).origin;
    const previousReservation = this.hostReservations.get(origin) ?? Promise.resolve();
    let releaseReservation;
    const currentReservation = new Promise((resolve) => {
      releaseReservation = resolve;
    });
    this.hostReservations.set(origin, currentReservation);

    await previousReservation;

    try {
      const now = Date.now();
      const previousNextAvailableAt = this.nextAvailableAt.get(origin) ?? null;
      const waitMs = Math.max(0, (previousNextAvailableAt ?? now) - now);
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      this.nextAvailableAt.set(origin, Date.now() + crawlDelayMs);
      const appliedDelayMs = previousNextAvailableAt ? Math.max(waitMs, crawlDelayMs) : waitMs;
      this.stats.totalDelayMs += appliedDelayMs;
      return { waitMs, crawlDelayMs };
    } finally {
      releaseReservation();
      if (this.hostReservations.get(origin) === currentReservation) {
        this.hostReservations.delete(origin);
      }
    }
  }

  async seedSitemaps(seedUrls, enqueue) {
    if (!this.isEnabled() || this.config.seedSitemaps === false) {
      return this.snapshot();
    }

    const origins = uniqueOrigins(seedUrls);
    const maxSitemaps = Number(this.config.maxSitemaps ?? 10);
    const maxUrlsPerSitemap = Number(this.config.maxUrlsPerSitemap ?? 200);

    for (const origin of origins) {
      const record = await this.loadOriginRecord(origin);
      const sitemapQueue = record.sitemapUrls
        .filter((value) => {
          try {
            return new URL(value).origin === origin;
          } catch {
            return false;
          }
        })
        .slice(0, maxSitemaps);
      const seenSitemaps = new Set();
      let discoveredCount = 0;

      while (sitemapQueue.length > 0 && seenSitemaps.size < maxSitemaps && discoveredCount < maxUrlsPerSitemap) {
        const sitemapUrl = sitemapQueue.shift();
        if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) {
          continue;
        }
        seenSitemaps.add(sitemapUrl);

        const document = await this.fetchSitemapDocument(sitemapUrl);
        if (!document) {
          continue;
        }

        if (document.type === 'index') {
          for (const childUrl of document.locations) {
            if (sitemapQueue.length + seenSitemaps.size >= maxSitemaps) {
              break;
            }

            try {
              if (new URL(childUrl).origin === origin) {
                sitemapQueue.push(childUrl);
              }
            } catch {
              // Ignore invalid child sitemap entries.
            }
          }
          continue;
        }

        for (const discoveredUrl of document.locations) {
          if (discoveredCount >= maxUrlsPerSitemap) {
            break;
          }

          try {
            if (new URL(discoveredUrl).origin !== origin) {
              continue;
            }
          } catch {
            continue;
          }

          this.stats.sitemapUrlsDiscovered += 1;
          const added = await enqueue(discoveredUrl, sitemapUrl);
          if (added) {
            this.stats.sitemapUrlsEnqueued += 1;
          }
          discoveredCount += 1;
        }
      }
    }

    return this.snapshot();
  }

  async loadOriginRecord(urlOrOrigin) {
    const origin = urlOrOrigin.startsWith('http://') || urlOrOrigin.startsWith('https://')
      ? new URL(urlOrOrigin).origin
      : urlOrOrigin;

    if (this.records.has(origin)) {
      return this.records.get(origin);
    }

    if (this.pendingLoads.has(origin)) {
      return this.pendingLoads.get(origin);
    }

    const pending = this.fetchOriginRecord(origin)
      .then((record) => {
        this.records.set(origin, record);
        this.stats.originsSeen = this.records.size;
        return record;
      })
      .finally(() => {
        this.pendingLoads.delete(origin);
      });

    this.pendingLoads.set(origin, pending);
    return pending;
  }

  async fetchOriginRecord(origin) {
    const robotsUrl = buildRobotsUrl(origin);

    try {
      this.stats.robotsFetchCount += 1;
      const response = await this.fetchPolicyDocument(robotsUrl);

      if (response.status >= 400 || !response.body) {
        return {
          origin,
          robotsUrl,
          rules: [],
          crawlDelayMs: 0,
          sitemapUrls: [],
          loadError: response.status >= 400 ? `robots responded with status ${response.status}` : null,
        };
      }

      const parsed = parseRobotsTxt(response.body);
      const resolved = resolveRobotsRules(parsed, this.userAgent);
      const crawlDelayMs = Math.min(
        Math.round((resolved.crawlDelaySeconds ?? 0) * 1000),
        Number(this.config.maxCrawlDelayMs ?? 30000),
      );

      return {
        origin,
        robotsUrl,
        rules: resolved.rules,
        crawlDelayMs: Number.isFinite(crawlDelayMs) ? crawlDelayMs : 0,
        sitemapUrls: resolved.sitemapUrls,
        loadError: null,
      };
    } catch (error) {
      this.logger?.warn?.('crawl policy robots fetch failed', {
        origin,
        error: error?.message ?? String(error),
      });

      return {
        origin,
        robotsUrl,
        rules: [],
        crawlDelayMs: 0,
        sitemapUrls: [],
        loadError: error?.message ?? String(error),
      };
    }
  }

  async fetchSitemapDocument(sitemapUrl) {
    try {
      this.stats.sitemapFetchCount += 1;
      const response = await this.fetchPolicyDocument(sitemapUrl);

      if (response.status >= 400 || !response.body) {
        return null;
      }

      return parseSitemapDocument(response.body);
    } catch (error) {
      this.logger?.warn?.('crawl policy sitemap fetch failed', {
        sitemapUrl,
        error: error?.message ?? String(error),
      });
      return null;
    }
  }

  async fetchPolicyDocument(targetUrl) {
    const headers = this.userAgent === '*' ? {} : { 'user-agent': this.userAgent };
    const proxy = await this.resolvePolicyProxy(targetUrl);

    try {
      const response = await fetchWithHttp({
        url: targetUrl,
        method: 'GET',
        headers,
        timeoutMs: Number(this.config.timeoutMs ?? 10000),
        proxy,
      });

      if (proxy?.server) {
        this.stats.proxiedPolicyFetchCount += 1;
        await this.proxyPool?.reportSuccess(proxy);
      } else {
        this.stats.directPolicyFetchCount += 1;
      }

      return response;
    } catch (error) {
      if (proxy?.server) {
        this.stats.policyProxyFailureCount += 1;
        await this.proxyPool?.reportFailure(proxy, {
          message: error?.message ?? String(error),
          proxyPool: this.workflow.proxyPool,
        });
      }
      throw error;
    }
  }

  async resolvePolicyProxy(targetUrl) {
    if (!this.proxyPool) {
      return this.workflow.proxy ?? null;
    }

    const selectedProxy = await this.proxyPool.selectProxy({
      proxyPool: this.workflow.proxyPool,
      fallbackProxy: this.workflow.proxy ?? null,
      affinityKey: `crawl-policy:${new URL(targetUrl).origin}`,
      targetUrl,
    });
    const directAllowed = !this.workflow.proxyPool?.enabled || this.workflow.proxyPool?.allowDirectFallback === true || Boolean(this.workflow.proxy);

    if (!selectedProxy?.server && !directAllowed) {
      throw new Error(`crawl policy request requires proxy for ${targetUrl}`);
    }

    return selectedProxy;
  }
}
