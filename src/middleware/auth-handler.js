/**
 * OAuth2 / JWT / Digest authentication middleware.
 *
 * Automatically handles OAuth2 authorization flows (authorization code,
 * client credentials, refresh token), JWT token lifecycle (acquire +
 * auto-refresh before expiry), and HTTP Digest authentication.
 *
 * Usage:
 *   import { createAuthHandler } from '../middleware/auth-handler.js';
 *   const auth = createAuthHandler({ type: 'oauth2', ... });
 *   await auth.init();
 *   const headers = await auth.getAuthHeaders();
 */

import { createLogger } from '../core/logger.js';
import { AppError } from '../core/errors.js';
import { createHash } from 'node:crypto';

const log = createLogger('auth-handler');

// ─── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an authentication handler based on the specified type.
 *
 * @param {object} config
 * @param {'oauth2'|'jwt'|'digest'} config.type - Authentication type
 * @returns {object} Auth handler with init(), getAuthHeaders(), refresh(), teardown()
 */
export function createAuthHandler(config) {
  switch (config.type) {
    case 'oauth2':   return createOAuth2Handler(config);
    case 'jwt':      return createJwtHandler(config);
    case 'digest':   return createDigestHandler(config);
    default:
      throw new AppError(400, `Unsupported auth type: ${config.type}`);
  }
}

// ─── OAuth2 handler ─────────────────────────────────────────────────────────

function createOAuth2Handler(config) {
  const {
    authorizeUrl,
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
      if (!accessToken || Date.now() >= expiresAt - 30_000) {
        await this.refresh();
      }
      return { Authorization: `${tokenType} ${accessToken}` };
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
        const text = await resp.text();
        throw new AppError(resp.status, `OAuth2 token refresh failed: ${text}`);
      }

      const data = await resp.json();
      accessToken = data.access_token;
      refreshToken = data.refresh_token ?? refreshToken;
      tokenType = data.token_type ?? 'Bearer';
      expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
      log.info('OAuth2 token refreshed', { expiresAt });
    },

    teardown() {
      accessToken = null;
      refreshToken = null;
    },
  };
}

// ─── JWT handler ─────────────────────────────────────────────────────────────

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
  } = config;

  let token = null;
  let expiresAt = 0;

  return {
    async init() {
      await this.refresh();
      log.info('JWT handler initialized');
    },

    async getAuthHeaders() {
      if (!token || Date.now() >= expiresAt - leewaySeconds * 1000) {
        await this.refresh();
      }
      return { Authorization: `Bearer ${token}` };
    },

    async refresh() {
      const url = (!token && refreshUrl) ? acquireUrl : (refreshUrl ?? acquireUrl);
      const reqBody = (!token && refreshBody) ? acquireBody : (refreshBody ?? acquireBody);
      const reqHeaders = (!token && refreshHeaders) ? acquireHeaders : (refreshHeaders ?? acquireHeaders);

      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...reqHeaders },
        body: reqBody ? JSON.stringify(reqBody) : undefined,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new AppError(resp.status, `JWT acquire/refresh failed: ${text}`);
      }

      const data = await resp.json();
      token = resolvePath(data, tokenPath);
      const expiresIn = resolvePath(data, expiresInPath);
      expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : Date.now() + 3600_000;
      log.info('JWT token acquired/refreshed', { expiresAt });
    },

    teardown() {
      token = null;
    },
  };
}

// ─── Digest auth handler ─────────────────────────────────────────────────────

function createDigestHandler(config) {
  const { username, password } = config;
  let cachedChallenge = null;

  return {
    async init() {
      log.info('Digest auth handler initialized', { username });
    },

    /**
     * Get authentication headers for a request.
     *
     * Note: For the first request to a Digest-protected URL, this method
     * makes an initial unauthenticated request to obtain the challenge,
     * then computes the Authorization header. Callers can avoid the
     * double-request by passing the 401 response to preSeedChallenge().
     *
     * @param {string} url
     * @param {string} [method='GET']
     * @returns {Promise<object>}
     */
    async getAuthHeaders(url, method = 'GET') {
      if (!cachedChallenge) {
        const probeResp = await fetch(url, { method });
        const wwwAuth = probeResp.headers.get('www-authenticate');
        if (!wwwAuth) return {};
        cachedChallenge = parseDigestChallenge(wwwAuth);
      }

      const authHeader = buildDigestResponse({
        ...cachedChallenge,
        username,
        password,
        uri: new URL(url).pathname,
        method,
      });
      return { Authorization: authHeader };
    },

    /**
     * Pre-seed the digest challenge from an existing 401 response,
     * avoiding the double-request penalty.
     *
     * @param {string} wwwAuth - The WWW-Authenticate header value
     */
    preSeedChallenge(wwwAuth) {
      cachedChallenge = parseDigestChallenge(wwwAuth);
    },

    refresh() {
      cachedChallenge = null;
    },

    teardown() {
      cachedChallenge = null;
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function performAuthorizationCodeFlow(config) {
  const { authorizeUrl, clientId, redirectUri, scopes } = config;
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
  const match = wwwAuth.match(/Digest\s+(.+)/i);
  if (!match) return challenge;
  const parts = match[1];
  for (const m of parts.matchAll(/(\w+)=(?:["]([^"]*)["]|([\w/]+))/g)) {
    challenge[m[1]] = m[2] ?? m[3];
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

function resolvePath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}
