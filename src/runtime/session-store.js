import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';
import { slugify } from '../utils/slug.js';

function nowIso() {
  return new Date().toISOString();
}

function createEmptySnapshot(sessionId) {
  const now = nowIso();
  return {
    id: sessionId,
    createdAt: now,
    updatedAt: now,
    cookies: [],
    origins: {},
    auth: {
      headers: {},
      query: {},
      cookies: {},
      tokens: {},
      replayState: {},
    },
    lastUrl: null,
  };
}

function parseSetCookie(setCookieHeader, targetUrl) {
  const [cookiePair, ...attributes] = String(setCookieHeader).split(';').map((part) => part.trim());
  const separatorIndex = cookiePair.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const target = new URL(targetUrl);
  const cookie = {
    name: cookiePair.slice(0, separatorIndex),
    value: cookiePair.slice(separatorIndex + 1),
    domain: target.hostname,
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: target.protocol === 'https:',
    sameSite: undefined,
  };

  for (const attribute of attributes) {
    const [rawKey, ...rest] = attribute.split('=');
    const key = rawKey.toLowerCase();
    const value = rest.join('=');

    switch (key) {
      case 'domain':
        cookie.domain = value.replace(/^\./, '');
        break;
      case 'path':
        cookie.path = value || '/';
        break;
      case 'max-age':
        cookie.expires = Math.floor(Date.now() / 1000) + Number(value || 0);
        break;
      case 'expires': {
        const parsed = Date.parse(value);
        cookie.expires = Number.isNaN(parsed) ? -1 : Math.floor(parsed / 1000);
        break;
      }
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'secure':
        cookie.secure = true;
        break;
      case 'samesite':
        cookie.sameSite = value || undefined;
        break;
      default:
        if (key === 'httponly' || key === 'secure') {
          cookie[key === 'httponly' ? 'httpOnly' : 'secure'] = true;
        }
    }
  }

  return cookie;
}

function isCookieExpired(cookie) {
  return typeof cookie.expires === 'number' && cookie.expires > 0 && cookie.expires <= Math.floor(Date.now() / 1000);
}

function cookieMatchesUrl(cookie, targetUrl) {
  try {
    const target = new URL(targetUrl);
    const host = target.hostname;
    const domain = String(cookie.domain ?? '').replace(/^\./, '');
    const domainMatch = host === domain || host.endsWith(`.${domain}`);
    const pathMatch = target.pathname.startsWith(cookie.path ?? '/');
    const secureMatch = !cookie.secure || target.protocol === 'https:';
    return domainMatch && pathMatch && secureMatch && !isCookieExpired(cookie);
  } catch {
    return false;
  }
}

function upsertCookie(cookies, nextCookie) {
  const filtered = cookies.filter(
    (cookie) => !(cookie.name === nextCookie.name && cookie.domain === nextCookie.domain && cookie.path === nextCookie.path),
  );

  if (!isCookieExpired(nextCookie)) {
    filtered.push(nextCookie);
  }

  return filtered;
}

function normalizeOrigins(snapshot = {}) {
  if (snapshot.origins && typeof snapshot.origins === 'object' && !Array.isArray(snapshot.origins)) {
    return structuredClone(snapshot.origins);
  }

  const origins = {};
  if (snapshot.localStorage && typeof snapshot.localStorage === 'object') {
    for (const [origin, values] of Object.entries(snapshot.localStorage)) {
      origins[origin] = {
        ...(origins[origin] ?? {}),
        localStorage: { ...(values ?? {}) },
      };
    }
  }
  if (snapshot.sessionStorage && typeof snapshot.sessionStorage === 'object') {
    for (const [origin, values] of Object.entries(snapshot.sessionStorage)) {
      origins[origin] = {
        ...(origins[origin] ?? {}),
        sessionStorage: { ...(values ?? {}) },
      };
    }
  }
  return origins;
}

function normalizeAuthState(snapshot = {}) {
  const auth = snapshot.auth && typeof snapshot.auth === 'object' && !Array.isArray(snapshot.auth)
    ? snapshot.auth
    : {};
  return {
    headers: { ...(auth.headers ?? {}) },
    query: { ...(auth.query ?? {}) },
    cookies: { ...(auth.cookies ?? {}) },
    tokens: { ...(auth.tokens ?? {}) },
    replayState: { ...(auth.replayState ?? {}) },
  };
}

function normalizeSnapshot(snapshot = {}) {
  const normalized = {
    ...snapshot,
    cookies: Array.isArray(snapshot.cookies) ? snapshot.cookies.filter((cookie) => !isCookieExpired(cookie)) : [],
    origins: normalizeOrigins(snapshot),
    auth: normalizeAuthState(snapshot),
  };

  delete normalized.localStorage;
  delete normalized.sessionStorage;
  return normalized;
}

function mergeNested(base = {}, next = {}) {
  return {
    ...(base ?? {}),
    ...(next ?? {}),
  };
}

function extractTokenLikeValues(value, trail = [], output = {}) {
  if (value === null || value === undefined) {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => extractTokenLikeValues(entry, [...trail, String(index)], output));
    return output;
  }

  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      extractTokenLikeValues(entry, [...trail, key], output);
    }
    return output;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const key = trail[trail.length - 1] ?? '';
    if (/(token|auth|session|csrf|nonce|bearer|jwt|api[_-]?key|secret)/i.test(key)) {
      output[trail.join('.')] = value;
    }
  }

  return output;
}

async function addInitScriptCompat(page, script, arg) {
  if (typeof page?.evaluateOnNewDocument === 'function') {
    await page.evaluateOnNewDocument(script, arg);
    return;
  }
  await page?.addInitScript?.(script, arg);
}

async function setCookiesCompat(context, cookies = []) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return;
  }
  if (typeof context?.addCookies === 'function') {
    await context.addCookies(cookies);
    return;
  }
  if (typeof context?.setCookie === 'function') {
    await context.setCookie(...cookies);
  }
}

export class SessionStore {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, '.omnicrawl', 'sessions');
    this.cache = new Map();
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = ensureDir(this.storageDir);
    }

    await this.initPromise;
    return this;
  }

  buildSessionPath(sessionId) {
    const safeName = `${slugify(sessionId) || 'session'}-${hashText(sessionId).slice(0, 12)}.json`;
    return join(this.storageDir, safeName);
  }

  async load(sessionId) {
    await this.init();

    if (this.cache.has(sessionId)) {
      return structuredClone(this.cache.get(sessionId));
    }

    try {
      const snapshot = normalizeSnapshot(await readJson(this.buildSessionPath(sessionId)));
      this.cache.set(sessionId, snapshot);
      return structuredClone(snapshot);
    } catch {
      const snapshot = createEmptySnapshot(sessionId);
      this.cache.set(sessionId, snapshot);
      return structuredClone(snapshot);
    }
  }

  async save(snapshot) {
    await this.init();
    const base = createEmptySnapshot(snapshot.id);
    const nextSnapshot = normalizeSnapshot({
      ...base,
      ...snapshot,
      auth: mergeNested(base.auth, snapshot.auth),
      updatedAt: nowIso(),
    });
    this.cache.set(nextSnapshot.id, nextSnapshot);
    await writeJson(this.buildSessionPath(nextSnapshot.id), nextSnapshot);
    return nextSnapshot;
  }

  async list(limit = 100) {
    await this.init();
    const files = (await readdir(this.storageDir)).filter((name) => name.endsWith('.json'));
    const items = [];

    for (const file of files) {
      try {
        const snapshot = normalizeSnapshot(await readJson(join(this.storageDir, file)));
        items.push({
          id: snapshot.id,
          updatedAt: snapshot.updatedAt,
          createdAt: snapshot.createdAt,
          cookieCount: snapshot.cookies.length,
          originCount: Object.keys(snapshot.origins ?? {}).length,
          lastUrl: snapshot.lastUrl ?? null,
        });
      } catch {
        continue;
      }
    }

    return items
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
      .slice(0, limit);
  }

  buildCookieHeader(snapshot, targetUrl) {
    const cookieEntries = [
      ...(snapshot.cookies ?? [])
        .filter((cookie) => cookieMatchesUrl(cookie, targetUrl))
        .map((cookie) => `${cookie.name}=${cookie.value}`),
      ...Object.entries(snapshot.auth?.cookies ?? {}).map(([name, value]) => `${name}=${value}`),
    ];
    return [...new Set(cookieEntries)].join('; ');
  }

  buildRequestHeaders(snapshot, targetUrl, options = {}) {
    const headers = {
      ...(snapshot.auth?.headers ?? {}),
      ...(options.headers ?? {}),
    };
    if (options.includeCookies !== false) {
      const cookieHeader = this.buildCookieHeader(snapshot, targetUrl);
      if (cookieHeader) {
        headers.cookie = cookieHeader;
      }
    }
    return headers;
  }

  async mergeHttpResponse(sessionId, targetUrl, setCookieHeaders = [], options = {}) {
    const snapshot = await this.load(sessionId);
    let cookies = snapshot.cookies ?? [];

    for (const header of setCookieHeaders) {
      const parsed = parseSetCookie(header, targetUrl);
      if (parsed) {
        cookies = upsertCookie(cookies, parsed);
      }
    }

    snapshot.cookies = cookies;
    snapshot.lastUrl = targetUrl;

    if (options.headers && typeof options.headers === 'object') {
      const authHeaders = {};
      for (const [key, value] of Object.entries(options.headers)) {
        if (/^(authorization|x-auth-token|x-csrf-token|x-api-key)$/i.test(key)) {
          authHeaders[key.toLowerCase()] = value;
        }
      }
      snapshot.auth.headers = mergeNested(snapshot.auth.headers, authHeaders);
    }

    if (options.body && typeof options.body === 'object') {
      snapshot.auth.tokens = mergeNested(snapshot.auth.tokens, extractTokenLikeValues(options.body));
    }

    if (options.replayState && typeof options.replayState === 'object') {
      snapshot.auth.replayState = mergeNested(snapshot.auth.replayState, options.replayState);
    }

    return this.save(snapshot);
  }

  async mergeAuthState(sessionId, authState = {}) {
    const snapshot = await this.load(sessionId);
    snapshot.auth = {
      headers: mergeNested(snapshot.auth.headers, authState.headers),
      query: mergeNested(snapshot.auth.query, authState.query),
      cookies: mergeNested(snapshot.auth.cookies, authState.cookies),
      tokens: mergeNested(snapshot.auth.tokens, authState.tokens),
      replayState: mergeNested(snapshot.auth.replayState, authState.replayState),
    };
    return this.save(snapshot);
  }

  async buildRequestState(sessionId, targetUrl, options = {}) {
    const snapshot = await this.load(sessionId);
    return {
      headers: this.buildRequestHeaders(snapshot, targetUrl, options),
      replayState: {
        ...(snapshot.auth?.tokens ?? {}),
        ...(snapshot.auth?.replayState ?? {}),
      },
      snapshot,
    };
  }

  async setOriginStorage(sessionId, origin, { localStorage = null, sessionStorage = null } = {}) {
    const snapshot = await this.load(sessionId);
    snapshot.origins[origin] = {
      ...(snapshot.origins[origin] ?? {}),
      ...(localStorage ? { localStorage: { ...localStorage } } : {}),
      ...(sessionStorage ? { sessionStorage: { ...sessionStorage } } : {}),
    };
    return this.save(snapshot);
  }

  async restoreBrowserSession({ sessionId, context, page }) {
    const snapshot = await this.load(sessionId);
    const cookies = (snapshot.cookies ?? []).filter((cookie) => !isCookieExpired(cookie));

    if (cookies.length > 0) {
      await setCookiesCompat(context, cookies);
    }

    const originMap = snapshot.origins ?? {};
    await addInitScriptCompat(page, (storageMap) => {
      const entry = storageMap[location.origin];
      if (!entry) return;

      if (entry.localStorage && typeof entry.localStorage === 'object') {
        localStorage.clear();
        for (const [key, value] of Object.entries(entry.localStorage)) {
          localStorage.setItem(key, String(value));
        }
      }

      if (entry.sessionStorage && typeof entry.sessionStorage === 'object') {
        sessionStorage.clear();
        for (const [key, value] of Object.entries(entry.sessionStorage)) {
          sessionStorage.setItem(key, String(value));
        }
      }
    }, originMap);

    return snapshot;
  }

  async captureBrowserSession({ sessionId, context, page, finalUrl, captureStorage = true }) {
    const snapshot = await this.load(sessionId);
    snapshot.cookies = await context.cookies();
    snapshot.lastUrl = finalUrl ?? snapshot.lastUrl ?? null;

    if (captureStorage) {
      try {
        const pageStorage = await page.evaluate(() => ({
          origin: location.origin,
          localStorage: (() => {
            const values = {};
            for (let index = 0; index < localStorage.length; index += 1) {
              const key = localStorage.key(index);
              if (key !== null) values[key] = localStorage.getItem(key);
            }
            return values;
          })(),
          sessionStorage: (() => {
            const values = {};
            for (let index = 0; index < sessionStorage.length; index += 1) {
              const key = sessionStorage.key(index);
              if (key !== null) values[key] = sessionStorage.getItem(key);
            }
            return values;
          })(),
        }));

        if (pageStorage?.origin) {
          snapshot.origins[pageStorage.origin] = {
            localStorage: pageStorage.localStorage ?? {},
            sessionStorage: pageStorage.sessionStorage ?? {},
          };
          snapshot.auth.tokens = mergeNested(
            snapshot.auth.tokens,
            extractTokenLikeValues(pageStorage.localStorage),
          );
          snapshot.auth.replayState = mergeNested(
            snapshot.auth.replayState,
            pageStorage.localStorage ?? {},
          );
        }
      } catch {
        // Ignore storage capture failures for non-standard pages.
      }
    }

    return this.save(snapshot);
  }
}
