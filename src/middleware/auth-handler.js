/**
 * Authentication middleware.
 *
 * Supports:
 * - OAuth2
 * - JWT / token endpoints
 * - HTTP Digest
 * - Basic auth
 * - Static bearer tokens
 * - API keys (header/query/cookie)
 * - Static cookies
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';
import { createHash } from 'node:crypto';

const log = createLogger('auth-handler');

function resolvePath(obj, path) {
  return String(path ?? '').split('.').reduce((acc, key) => acc?.[key], obj);
}

function ensureRequestShape(request = {}) {
  return {
    ...(request ?? {}),
    url: request?.url ?? '',
    headers: { ...(request?.headers ?? {}) },
  };
}

function setHeader(headers = {}, name, value) {
  const next = { ...(headers ?? {}) };
  const target = String(name).toLowerCase();
  for (const key of Object.keys(next)) {
    if (String(key).toLowerCase() === target) {
      delete next[key];
    }
  }
  next[name] = value;
  return next;
}

function appendCookieHeader(existing = '', name, value) {
  const entry = `${name}=${value}`;
  if (!existing) {
    return entry;
  }
  const current = String(existing);
  return current.includes(entry) ? current : `${current}; ${entry}`;
}

function addQueryParam(url, key, value) {
  const target = new URL(String(url));
  target.searchParams.set(String(key), String(value));
  return target.toString();
}

function createStaticHandler({
  getHeaders = async () => ({}),
  refresh = async () => true,
  isExpiring = () => false,
  applyToRequest = async (request) => ({
    ...ensureRequestShape(request),
    headers: {
      ...(ensureRequestShape(request).headers ?? {}),
      ...(await getHeaders(request)),
    },
  }),
}) {
  return {
    async init() {},
    async getAuthHeaders(request) {
      return getHeaders(request);
    },
    refresh,
    isExpiring,
    applyToRequest,
    teardown() {},
  };
}

export function createAuthHandler(config) {
  switch (config.type) {
    case 'oauth2': return createOAuth2Handler(config);
    case 'jwt': return createJwtHandler(config);
    case 'digest': return createDigestHandler(config);
    case 'basic': return createBasicHandler(config);
    case 'bearer': return createBearerHandler(config);
    case 'api-key': return createApiKeyHandler(config);
    case 'cookie': return createCookieHandler(config);
    default:
      throw new AppError(400, `Unsupported auth type: ${config.type}`);
  }
}

function createOAuth2Handler(config) {
  const {
    tokenUrl,
    clientId,
    clientSecret,
    redirectUri = 'http://localhost:9876/callback',
    scopes = [],
    grantType = 'authorization_code',
    refreshToken: initialRefreshToken,
    accessToken: initialAccessToken,
    expiresIn: initialExpiresIn,
  } = config;

  let accessToken = initialAccessToken ?? null;
  let refreshToken = initialRefreshToken ?? null;
  let expiresAt = initialExpiresIn ? Date.now() + initialExpiresIn * 1000 : 0;
  let tokenType = 'Bearer';

  return {
    async init() {
      if (grantType === 'client_credentials') {
        await this.refresh();
      } else if (!accessToken && grantType === 'authorization_code') {
        await performAuthorizationCodeFlow(config);
      }
      log.info('OAuth2 handler initialized', { grantType });
    },

    async getAuthHeaders() {
      if (!accessToken || this.isExpiring()) {
        await this.refresh();
      }
      return { Authorization: `${tokenType} ${accessToken}` };
    },

    isExpiring() {
      return !accessToken || Date.now() >= expiresAt - 30_000;
    },

    async refresh() {
      if (!tokenUrl) throw new AppError(400, 'OAuth2 tokenUrl is required for refresh');

      const body = new URLSearchParams();
      if (refreshToken) {
        body.set('grant_type', 'refresh_token');
        body.set('refresh_token', refreshToken);
      } else if (grantType === 'client_credentials') {
        body.set('grant_type', 'client_credentials');
        if (scopes.length) body.set('scope', scopes.join(' '));
      } else {
        throw new AppError(400, 'No refresh token and not client_credentials');
      }
      body.set('client_id', clientId);
      if (clientSecret) body.set('client_secret', clientSecret);

      const resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!resp.ok) {
        throw new AppError(resp.status, `OAuth2 token refresh failed: ${await resp.text()}`);
      }

      const data = await resp.json();
      accessToken = data.access_token;
      refreshToken = data.refresh_token ?? refreshToken;
      tokenType = data.token_type ?? 'Bearer';
      expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
      log.info('OAuth2 token refreshed', { expiresAt });
      return true;
    },

    async applyToRequest(request = {}) {
      const next = ensureRequestShape(request);
      next.headers = {
        ...next.headers,
        ...(await this.getAuthHeaders()),
      };
      return next;
    },

    teardown() {
      accessToken = null;
      refreshToken = null;
    },
  };
}

function createJwtHandler(config) {
  const {
    acquireUrl,
    method = 'POST',
    body: acquireBody,
    headers: acquireHeaders = {},
    tokenPath = 'token',
    expiresInPath = 'expires_in',
    refreshUrl,
    refreshBody,
    refreshHeaders,
    leewaySeconds = 30,
    tokenPrefix = 'Bearer',
  } = config;

  let token = config.token ?? null;
  let expiresAt = config.expiresIn ? Date.now() + config.expiresIn * 1000 : 0;

  return {
    async init() {
      if (!token) {
        await this.refresh();
      }
      log.info('JWT handler initialized');
    },

    isExpiring() {
      return !token || Date.now() >= expiresAt - leewaySeconds * 1000;
    },

    async getAuthHeaders() {
      if (this.isExpiring()) {
        await this.refresh();
      }
      return { Authorization: `${tokenPrefix} ${token}` };
    },

    async refresh() {
      const useRefreshLane = Boolean(token) && Boolean(refreshUrl);
      const url = useRefreshLane ? refreshUrl : acquireUrl;
      const reqBody = useRefreshLane ? (refreshBody ?? acquireBody) : acquireBody;
      const reqHeaders = useRefreshLane ? (refreshHeaders ?? acquireHeaders) : acquireHeaders;

      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...reqHeaders },
        body: reqBody ? JSON.stringify(reqBody) : undefined,
      });

      if (!resp.ok) {
        throw new AppError(resp.status, `JWT acquire/refresh failed: ${await resp.text()}`);
      }

      const data = await resp.json();
      token = resolvePath(data, tokenPath);
      const expiresIn = resolvePath(data, expiresInPath);
      expiresAt = expiresIn ? Date.now() + Number(expiresIn) * 1000 : Date.now() + 3600_000;
      log.info('JWT token acquired/refreshed', { expiresAt });
      return true;
    },

    async applyToRequest(request = {}) {
      const next = ensureRequestShape(request);
      next.headers = {
        ...next.headers,
        ...(await this.getAuthHeaders()),
      };
      return next;
    },

    teardown() {
      token = null;
      expiresAt = 0;
    },
  };
}

function createDigestHandler(config) {
  const { username, password } = config;
  let cachedChallenge = null;

  return {
    async init() {
      log.info('Digest auth handler initialized', { username });
    },

    async getAuthHeaders(url, method = 'GET') {
      if (!url) {
        throw new AppError(400, 'Digest auth requires a request URL');
      }

      if (!cachedChallenge) {
        const probeResp = await fetch(url, { method });
        const wwwAuth = probeResp.headers.get('www-authenticate');
        if (!wwwAuth) return {};
        cachedChallenge = parseDigestChallenge(wwwAuth);
      }

      return {
        Authorization: buildDigestResponse({
          ...cachedChallenge,
          username,
          password,
          uri: new URL(url).pathname,
          method,
        }),
      };
    },

    preSeedChallenge(wwwAuth) {
      cachedChallenge = parseDigestChallenge(wwwAuth);
    },

    isExpiring() {
      return false;
    },

    refresh() {
      cachedChallenge = null;
      return true;
    },

    async applyToRequest(request = {}) {
      const next = ensureRequestShape(request);
      next.headers = {
        ...next.headers,
        ...(await this.getAuthHeaders(next.url, next.method ?? 'GET')),
      };
      return next;
    },

    teardown() {
      cachedChallenge = null;
    },
  };
}

function createBasicHandler(config) {
  const { username, password } = config;
  if (username === undefined || password === undefined) {
    throw new AppError(400, 'Basic auth requires username and password');
  }

  const token = Buffer.from(`${username}:${password}`).toString('base64');
  return createStaticHandler({
    getHeaders: async () => ({ Authorization: `Basic ${token}` }),
  });
}

function createBearerHandler(config) {
  const { token, prefix = 'Bearer', headerName = 'Authorization' } = config;
  if (!token) {
    throw new AppError(400, 'Bearer auth requires token');
  }

  return createStaticHandler({
    getHeaders: async () => ({ [headerName]: `${prefix} ${token}`.trim() }),
  });
}

function createApiKeyHandler(config) {
  const {
    key,
    value,
    in: location = 'header',
    headerName = key ?? 'x-api-key',
    queryParam = key ?? 'api_key',
    cookieName = key ?? 'api_key',
  } = config;

  if (!value) {
    throw new AppError(400, 'API key auth requires value');
  }

  return createStaticHandler({
    getHeaders: async () => (
      location === 'header'
        ? { [headerName]: String(value) }
        : location === 'cookie'
          ? { Cookie: `${cookieName}=${value}` }
          : {}
    ),
    applyToRequest: async (request = {}) => {
      const next = ensureRequestShape(request);
      if (location === 'query') {
        next.url = addQueryParam(next.url, queryParam, value);
        return next;
      }
      if (location === 'cookie') {
        next.headers = setHeader(
          next.headers,
          'Cookie',
          appendCookieHeader(next.headers.Cookie ?? next.headers.cookie ?? '', cookieName, value),
        );
        return next;
      }
      next.headers = setHeader(next.headers, headerName, String(value));
      return next;
    },
  });
}

function createCookieHandler(config) {
  const cookieMap = typeof config.cookie === 'string'
    ? { raw: config.cookie }
    : config.cookies ?? {};
  const buildHeaders = async () => {
    if (typeof cookieMap.raw === 'string') {
      return { Cookie: cookieMap.raw };
    }
    const cookieHeader = Object.entries(cookieMap)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    return cookieHeader ? { Cookie: cookieHeader } : {};
  };

  return createStaticHandler({
    getHeaders: buildHeaders,
    applyToRequest: async (request = {}) => {
      const next = ensureRequestShape(request);
      const headers = await buildHeaders();
      next.headers = {
        ...next.headers,
        ...headers,
      };
      return next;
    },
  });
}

async function performAuthorizationCodeFlow(config) {
  const { authorizeUrl, clientId, redirectUri, scopes = [] } = config;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
  });
  const authUrl = `${authorizeUrl}?${params}`;
  log.info('OAuth2 authorization URL generated', { authUrl });
}

function parseDigestChallenge(wwwAuth) {
  const challenge = {};
  const match = String(wwwAuth ?? '').match(/Digest\s+(.+)/i);
  if (!match) return challenge;
  for (const item of match[1].matchAll(/(\w+)=(?:["]([^"]*)["]|([\w/]+))/g)) {
    challenge[item[1]] = item[2] ?? item[3];
  }
  return challenge;
}

function buildDigestResponse(params) {
  const {
    realm, nonce, qop = 'auth', username, password,
    uri, method, nc = '00000001', cnonce = 'omnicrawl',
  } = params;
  const ha1 = md5Hex(`${username}:${realm}:${password}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const response = md5Hex(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

function md5Hex(str) {
  return createHash('md5').update(str).digest('hex');
}
