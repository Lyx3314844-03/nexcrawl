import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import { SocksProxyAgent } from 'socks-proxy-agent';
import {
  getBrowserTLSProfile,
  createTLSAgent,
  buildTLSOptions,
} from './tls-fingerprint.js';
import {
  buildH2Headers,
  buildHttp2SessionOptions,
  getH2BrowserProfile,
} from './http2-fingerprint.js';

function normalizeHeaders(headers = {}) {
  const nextHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) {
      nextHeaders[key.toLowerCase()] = String(value);
    }
  }

  return nextHeaders;
}

function isRedirectStatus(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy?.username && !proxy?.password) {
    return null;
  }

  return `Basic ${Buffer.from(`${proxy.username ?? ''}:${proxy.password ?? ''}`).toString('base64')}`;
}

function clientForProtocol(protocol) {
  return protocol === 'https:' ? https : http;
}

function collectBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    response.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    response.on('error', reject);
  });
}

function setCookieArray(headers) {
  const value = headers['set-cookie'];
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function responseShape({ requestUrl, finalUrl, response, body, proxy, transport = null }) {
  return {
    mode: 'http',
    url: requestUrl,
    finalUrl,
    ok: (response.statusCode ?? 500) < 400,
    status: response.statusCode ?? 500,
    headers: response.headers,
    body,
    sessionId: null,
    proxyServer: proxy?.server ?? null,
    transport,
    fetchedAt: new Date().toISOString(),
  };
}

function absoluteProxyHeaders(targetUrl, headers, proxy) {
  const nextHeaders = {
    ...headers,
    host: targetUrl.host,
  };

  const proxyAuth = proxyAuthorizationHeader(proxy);
  if (proxyAuth) {
    nextHeaders['proxy-authorization'] = proxyAuth;
  }

  return nextHeaders;
}

function requestViaForwardProxy(targetUrl, request, headers, proxy) {
  const proxyUrl = new URL(proxy.server);
  const client = clientForProtocol(proxyUrl.protocol);

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: proxyUrl.hostname,
        port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
        method: request.method ?? 'GET',
        path: targetUrl.href,
        headers: absoluteProxyHeaders(targetUrl, headers, proxy),
      },
      async (response) => {
        try {
          const body = await collectBody(response);
          resolve({
            finalUrl: targetUrl.href,
            status: response.statusCode ?? 500,
            headers: response.headers,
            body,
          });
        } catch (error) {
          reject(error);
        }
      },
    );

    req.setTimeout(request.timeoutMs ?? 30000, () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    if (request.body) {
      req.write(request.body);
    }
    req.end();
  });
}

function requestViaSocksProxy(targetUrl, request, headers, proxy) {
  const agent = new SocksProxyAgent(proxy.server);
  const client = clientForProtocol(targetUrl.protocol);

  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: request.method ?? 'GET',
        headers: {
          ...headers,
          host: targetUrl.host,
        },
        agent,
      },
      async (response) => {
        try {
          const body = await collectBody(response);
          resolve({
            finalUrl: targetUrl.href,
            status: response.statusCode ?? 500,
            headers: response.headers,
            setCookieHeaders: setCookieArray(response.headers),
            body,
            transport: {
              protocol: targetUrl.protocol === 'https:' ? 'http/1.1' : 'http/1.1',
              proxyProtocol: new URL(proxy.server).protocol.replace(':', ''),
            },
          });
        } catch (error) {
          reject(error);
        }
      },
    );

    req.setTimeout(request.timeoutMs ?? 30000, () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    if (request.body) {
      req.write(request.body);
    }
    req.end();
  });
}

function createConnectTunnel(targetUrl, proxy, timeoutMs) {
  const proxyUrl = new URL(proxy.server);
  const client = clientForProtocol(proxyUrl.protocol);

  return new Promise((resolve, reject) => {
    const connectRequest = client.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${targetUrl.hostname}:${targetUrl.port || 443}`,
      headers: {
        host: `${targetUrl.hostname}:${targetUrl.port || 443}`,
        ...(proxyAuthorizationHeader(proxy)
          ? { 'proxy-authorization': proxyAuthorizationHeader(proxy) }
          : {}),
      },
    });

    connectRequest.setTimeout(timeoutMs ?? 30000, () => {
      connectRequest.destroy(new Error('proxy tunnel timed out'));
    });
    connectRequest.on('connect', (response, socket) => {
      if ((response.statusCode ?? 500) >= 400) {
        socket.destroy();
        reject(new Error(`proxy tunnel failed with status ${response.statusCode}`));
        return;
      }

      const tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
      });

      tlsSocket.once('secureConnect', () => resolve(tlsSocket));
      tlsSocket.once('error', reject);
    });
    connectRequest.on('error', reject);
    connectRequest.end();
  });
}

function requestViaTunnel(targetUrl, request, headers, proxy) {
  return new Promise(async (resolve, reject) => {
    let tlsSocket;

    try {
      tlsSocket = await createConnectTunnel(targetUrl, proxy, request.timeoutMs ?? 30000);
      const req = https.request(
        {
          host: targetUrl.hostname,
          port: targetUrl.port || 443,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: request.method ?? 'GET',
          headers: {
            ...headers,
            host: targetUrl.host,
          },
          createConnection: () => tlsSocket,
        },
        async (response) => {
          try {
            const body = await collectBody(response);
            resolve({
              finalUrl: targetUrl.href,
              status: response.statusCode ?? 500,
              headers: response.headers,
              body,
            });
          } catch (error) {
            reject(error);
          }
        },
      );

      req.setTimeout(request.timeoutMs ?? 30000, () => {
        req.destroy(new Error('request timed out'));
      });
      req.on('error', reject);
      if (request.body) {
        req.write(request.body);
      }
      req.end();
    } catch (error) {
      reject(error);
    }
  });
}

function requestDirectHttps(targetUrl, request, headers, tlsProfile) {
  return new Promise((resolve, reject) => {
    const agent = createTLSAgent({ profile: tlsProfile });
    const req = https.request(
      {
        host: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method: request.method ?? 'GET',
        headers: {
          ...headers,
          host: targetUrl.host,
        },
        agent,
      },
      async (response) => {
        try {
          const body = await collectBody(response);
          resolve({
            finalUrl: targetUrl.href,
            status: response.statusCode ?? 500,
            headers: response.headers,
            setCookieHeaders: setCookieArray(response.headers),
            body,
            transport: {
              protocol: 'http/1.1',
              alpnProtocol: tlsProfile?.alpn?.[0] ?? null,
              tlsProfile: tlsProfile?.name ?? null,
            },
          });
        } catch (error) {
          reject(error);
        }
      },
    );

    req.setTimeout(request.timeoutMs ?? 30000, () => {
      req.destroy(new Error('request timed out'));
    });
    req.on('error', reject);
    if (request.body) {
      req.write(request.body);
    }
    req.end();
  });
}

async function requestThroughProxy(targetUrl, request, headers, proxy) {
  const proxyProtocol = new URL(proxy.server).protocol.toLowerCase();
  if (proxyProtocol.startsWith('socks')) {
    return requestViaSocksProxy(targetUrl, request, headers, proxy);
  }

  if (targetUrl.protocol === 'http:') {
    return requestViaForwardProxy(targetUrl, request, headers, proxy);
  }

  if (targetUrl.protocol === 'https:') {
    return requestViaTunnel(targetUrl, request, headers, proxy);
  }

  throw new Error(`unsupported protocol for proxy request: ${targetUrl.protocol}`);
}

function normalizeHttp2ResponseHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(':')) {
      continue;
    }
    output[key.toLowerCase()] = Array.isArray(value) ? value.map((entry) => String(entry)) : String(value);
  }
  return output;
}

function shouldUseHttp2Request(targetUrl, proxy, h2Profile) {
  return targetUrl.protocol === 'https:' && !proxy && Boolean(h2Profile);
}

function requestViaHttp2(targetUrl, request, headers, tlsProfile, h2Profile) {
  const authority = `${targetUrl.protocol}//${targetUrl.host}`;
  const tlsOptions = buildTLSOptions(tlsProfile ?? undefined);
  const sessionOptions = buildHttp2SessionOptions({ tlsProfile, h2Profile });

  return new Promise((resolve, reject) => {
    const session = http2.connect(authority, {
      ...sessionOptions,
      createConnection: () => tls.connect({
        host: targetUrl.hostname,
        port: targetUrl.port || 443,
        servername: targetUrl.hostname,
        ...tlsOptions,
      }),
    });

    const cleanup = () => {
      session.removeAllListeners();
      session.close();
    };

    session.once('error', (error) => {
      cleanup();
      reject(error);
    });

    session.once('connect', () => {
      const requestHeaders = buildH2Headers({
        url: targetUrl.href,
        method: request.method ?? 'GET',
        headers,
      }, h2Profile);

      if (request.body !== undefined && request.body !== null && requestHeaders['content-length'] === undefined) {
        requestHeaders['content-length'] = String(Buffer.byteLength(String(request.body)));
      }

      const req = session.request(requestHeaders);
      const chunks = [];
      let responseHeaders = {};

      req.setTimeout(request.timeoutMs ?? 30000, () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        cleanup();
        reject(new Error('request timed out'));
      });

      req.on('response', (incomingHeaders) => {
        responseHeaders = incomingHeaders;
      });
      req.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const normalizedHeaders = normalizeHttp2ResponseHeaders(responseHeaders);
        const status = Number(responseHeaders[':status'] ?? 500);
        const body = Buffer.concat(chunks).toString('utf8');
        cleanup();
        resolve({
          finalUrl: targetUrl.href,
          status,
          headers: normalizedHeaders,
          setCookieHeaders: responseHeaders['set-cookie'] ?? [],
          body,
          transport: {
            protocol: 'h2',
            alpnProtocol: session.socket?.alpnProtocol ?? 'h2',
            settings: session.remoteSettings ?? sessionOptions.settings,
          },
        });
      });
      req.on('error', (error) => {
        cleanup();
        reject(error);
      });

      if (request.body !== undefined && request.body !== null) {
        req.write(request.body);
      }
      req.end();
    });
  });
}

function shouldSwitchToGet(status, method) {
  return status === 303 || ((status === 301 || status === 302) && !['GET', 'HEAD'].includes(method));
}

async function fetchWithoutProxy(request, headers, tlsProfile = null) {
  const targetUrl = new URL(request.url);
  if (targetUrl.protocol === 'https:' && tlsProfile) {
    return requestDirectHttps(targetUrl, request, headers, tlsProfile);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs ?? 30000);

  try {
    const fetchOptions = {
      method: request.method ?? 'GET',
      headers,
      body: request.body,
      signal: controller.signal,
    };

    // Apply TLS fingerprint if profile specified
    if (tlsProfile) {
      const agent = createTLSAgent({ profile: tlsProfile });
      fetchOptions.agent = agent;
    }

    const response = await fetch(request.url, fetchOptions);

    return {
      finalUrl: response.url,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      setCookieHeaders: response.headers.getSetCookie?.() ?? [],
      body: await response.text(),
      transport: {
        protocol: 'http/1.1',
        alpnProtocol: tlsProfile?.alpn?.[0] ?? null,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchWithHttp(request, { sessionStore } = {}) {
  const headers = normalizeHeaders(request.headers);
  const session = request.session?.enabled && request.session?.id ? request.session : null;
  const proxy = request.proxy ?? null;
  const tlsProfileName = request.tlsProfile ?? null;
  const tlsProfile = tlsProfileName ? getBrowserTLSProfile(tlsProfileName) : null;
  const h2ProfileName = request.h2Profile ?? null;
  const h2Profile = h2ProfileName ? getH2BrowserProfile(h2ProfileName) : null;

  // Apply H2 fingerprint header ordering if profile is specified
  if (h2Profile && h2Profile.headerOrder) {
    const orderedHeaders = {};
    for (const key of h2Profile.headerOrder) {
      if (headers[key] !== undefined) {
        orderedHeaders[key] = headers[key];
        delete headers[key];
      }
    }
    Object.assign(orderedHeaders, headers);
    Object.keys(headers).forEach(k => delete headers[k]);
    Object.assign(headers, orderedHeaders);
  }

  if (session && sessionStore && session.persist !== false && !headers.cookie) {
    const snapshot = await sessionStore.load(session.id);
    const cookieHeader = sessionStore.buildCookieHeader(snapshot, request.url);
    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }
  }

  let currentUrl = request.url;
  let currentMethod = request.method ?? 'GET';
  let currentBody = request.body;
  let redirectCount = 0;

  while (true) {
    const targetUrl = new URL(currentUrl);
    const currentRequest = {
      ...request,
      url: currentUrl,
      method: currentMethod,
      body: currentBody,
    };

    const response = proxy
      ? await requestThroughProxy(targetUrl, currentRequest, headers, proxy)
      : shouldUseHttp2Request(targetUrl, proxy, h2Profile)
        ? await requestViaHttp2(targetUrl, currentRequest, headers, tlsProfile, h2Profile)
        : await fetchWithoutProxy(currentRequest, headers, tlsProfile);

    const setCookieHeaders = response.setCookieHeaders ?? setCookieArray(response.headers);
    if (session && sessionStore && session.persist !== false && setCookieHeaders.length > 0) {
      await sessionStore.mergeHttpResponse(session.id, currentUrl, setCookieHeaders);
    }

    if (isRedirectStatus(response.status) && response.headers.location && redirectCount < 5) {
      redirectCount += 1;
      currentUrl = new URL(response.headers.location, currentUrl).href;
      if (shouldSwitchToGet(response.status, currentMethod)) {
        currentMethod = 'GET';
        currentBody = undefined;
      }

      if (session && sessionStore && session.persist !== false) {
        const snapshot = await sessionStore.load(session.id);
        const cookieHeader = sessionStore.buildCookieHeader(snapshot, currentUrl);
        if (cookieHeader) {
          headers.cookie = cookieHeader;
        }
      }
      continue;
    }

    return {
      mode: 'http',
      url: request.url,
      finalUrl: response.finalUrl,
      ok: response.status < 400,
      status: response.status,
      headers: response.headers,
      body: response.body,
      sessionId: session?.id ?? null,
      proxyServer: proxy?.server ?? null,
      transport: response.transport ?? null,
      fetchedAt: new Date().toISOString(),
    };
  }
}
