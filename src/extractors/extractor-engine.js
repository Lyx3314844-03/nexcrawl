import vm from 'node:vm';
import { queryHtmlBatch } from '../fetchers/browser-fetcher.js';
import { hashText } from '../utils/hash.js';
import { interpolateReplayValue, readObjectPath } from '../utils/replay-template.js';
import { runReverseOperation } from '../reverse/reverse-capabilities.js';
import { extractMediaAssets } from './media-extractor.js';
import { evaluateXPath } from './xpath-extractor.js';

function parseJsonMaybe(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function firstTitle(body) {
  const match = body.match(/<title>([^<]+)<\/title>/i);
  return match?.[1] ?? null;
}

function normalizeUnique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractLinksFallback(body, baseUrl, maxItems = 50, { format = 'url' } = {}) {
  const matches = body.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi);
  const links = [];

  for (const match of matches) {
    try {
      const url = new URL(match[1], baseUrl).href;
      if (format === 'object') {
        const fullTag = match[0];
        const relMatch = fullTag.match(/rel=["']([^"']+)["']/i);
        const rel = relMatch ? relMatch[1] : null;
        const nofollow = rel ? rel.toLowerCase().split(/\s+/).includes('nofollow') : false;

        links.push({
          url,
          text: null,
          tagName: 'a',
          rel,
          nofollow,
          hreflang: null,
          mediaType: null,
        });
      } else {
        links.push(url);
      }
    } catch {
      continue;
    }
  }

  return normalizeUnique(links).slice(0, maxItems);
}

function analyzeSurface(response) {
  const body = response.body;
  const scriptMatches = Array.from(body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi))
    .map((match) => {
      try {
        return new URL(match[1], response.finalUrl).href;
      } catch {
        return match[1];
      }
    })
    .slice(0, 50);

  const endpointMatches = Array.from(
    body.matchAll(/https?:\/\/[^\s"'<>`]+|\/api\/[A-Za-z0-9/_?&=.-]+/g),
  )
    .map((match) => match[0])
    .slice(0, 50);

  const cryptoSignals = normalizeUnique(
    Array.from(body.matchAll(/\b(cryptojs|aes|des|rsa|hmac|sha1|sha256|sha512|md5|base64)\b/gi)).map(
      (match) => match[0].toLowerCase(),
    ),
  );

  const obfuscationSignals = normalizeUnique(
    Array.from(body.matchAll(/eval\(|Function\(|fromCharCode|atob\(|btoa\(|\\x[0-9a-f]{2}|_0x[a-z0-9]+/gi)).map(
      (match) => match[0],
    ),
  );

  const antiAutomationSignals = normalizeUnique(
    Array.from(
      body.matchAll(/\b(webdriver|navigator\.plugins|navigator\.languages|webgl|canvas|fingerprint)\b/gi),
    ).map((match) => match[0]),
  );

  const bundlerSignals = normalizeUnique(
    Array.from(body.matchAll(/\b(__webpack_require__|webpackJsonp|vite|parcel|rollup)\b/gi)).map(
      (match) => match[0],
    ),
  );

  const inlineScriptCount = (body.match(/<script(?![^>]+src=)[^>]*>/gi) ?? []).length;

  return {
    bodyHash: hashText(body),
    title: response.domMeta?.title ?? firstTitle(body),
    scriptAssets: scriptMatches,
    inlineScriptCount,
    possibleApiEndpoints: endpointMatches,
    signals: {
      crypto: cryptoSignals,
      obfuscation: obfuscationSignals,
      antiAutomation: antiAutomationSignals,
      bundlers: bundlerSignals,
    },
    score:
      cryptoSignals.length * 3 +
      obfuscationSignals.length * 3 +
      antiAutomationSignals.length * 2 +
      bundlerSignals.length,
  };
}

function buildMeta(response) {
  return {
    url: response.finalUrl,
    status: response.status,
    contentType: response.headers['content-type'] ?? response.headers['Content-Type'] ?? null,
    title: response.domMeta?.title ?? firstTitle(response.body),
    bodyBytes: Buffer.byteLength(response.body),
    bodyHash: hashText(response.body),
  };
}

export async function applyRule({ rule, response, workflow, logger }) {
  const resolvedRule = response.replayState
    ? interpolateReplayValue(rule, response.replayState, { strict: true })
    : rule;

  switch (resolvedRule.type) {
    case 'regex': {
      const expression = new RegExp(
        resolvedRule.pattern ?? '',
        resolvedRule.all && !(resolvedRule.flags ?? '').includes('g') ? `${resolvedRule.flags ?? ''}g` : resolvedRule.flags ?? '',
      );
      if (resolvedRule.all) {
        const values = Array.from(response.body.matchAll(expression)).map((match) => match[1] ?? match[0]);
        return values.slice(0, resolvedRule.maxItems ?? 50);
      }

      const match = response.body.match(expression);
      return match?.[1] ?? match?.[0] ?? null;
    }

    case 'json': {
      const parsed = parseJsonMaybe(response.body);
      return parsed === null ? null : readObjectPath(parsed, resolvedRule.path);
    }

    case 'script': {
      const parsed = parseJsonMaybe(response.body);
      const source = resolvedRule.code?.includes('return ') ? `(function(){${resolvedRule.code}})()` : resolvedRule.code ?? 'null';

      return vm.runInNewContext(
        source,
        {
          body: response.body,
          json: parsed,
          headers: response.headers,
          meta: buildMeta(response),
          url: response.finalUrl,
        },
        { timeout: 1000 },
      );
    }

    case 'surface':
      return analyzeSurface(response);

    case 'reverse': {
      const contentType = response.headers['content-type'] ?? response.headers['Content-Type'] ?? '';
      const inferredMode =
        resolvedRule.mode === 'auto'
          ? contentType.includes('html') || /<html|<script/i.test(response.body)
            ? 'html'
            : 'script'
          : resolvedRule.mode;

      return runReverseOperation({
        ...resolvedRule,
        mode: inferredMode,
        code: typeof resolvedRule.code === 'string' && resolvedRule.code ? resolvedRule.code : response.body,
        html: response.body,
        target: response.finalUrl,
        baseUrl: response.finalUrl,
        title: buildMeta(response).title,
        curlCommand: typeof resolvedRule.curlCommand === 'string' ? resolvedRule.curlCommand : response.body,
      });
    }

    case 'xpath':
      return evaluateXPath(response.body, resolvedRule);

    case 'media':
      return extractMediaAssets(response, resolvedRule);

    case 'links':
    case 'selector':
      try {
        const result = await queryHtmlBatch(response.body, [resolvedRule], {
          baseUrl: response.finalUrl,
          browser: workflow.browser,
        });

        return result[resolvedRule.name] ?? null;
      } catch (error) {
        logger?.warn('dom extraction fallback used', {
          rule: resolvedRule.name,
          error: error?.message ?? String(error),
        });

        if (resolvedRule.type === 'links') {
          const links = extractLinksFallback(
            response.body,
            response.finalUrl,
            resolvedRule.maxItems ?? 50,
            { format: resolvedRule.format ?? 'url' },
          );
          return resolvedRule.all ? links : links[0] ?? null;
        }

        return null;
      }

    default:
      return null;
  }
}

export async function runExtractors({ workflow, response, logger }) {
  const extracted = {
    _meta: buildMeta(response),
  };

  for (const rule of workflow.extract) {
    extracted[rule.name] = await applyRule({
      rule,
      response,
      workflow,
      logger,
    });
  }

  return extracted;
}
