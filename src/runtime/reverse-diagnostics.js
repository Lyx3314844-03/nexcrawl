import { hashText } from '../utils/hash.js';

function lowerText(value, maxChars = 20_000) {
  return String(value ?? '').slice(0, maxChars).toLowerCase();
}

function isEmptyValue(value) {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function getH2ProfileName(profile) {
  if (!profile) {
    return null;
  }
  if (typeof profile === 'string') {
    return profile;
  }
  if (typeof profile !== 'object') {
    return String(profile);
  }
  if (typeof profile.name === 'string' && profile.name.trim()) {
    return profile.name;
  }
  if (typeof profile.profile === 'string' && profile.profile.trim()) {
    return profile.profile;
  }
  return 'custom';
}

function normalizeEndpoint(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function parseTime(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? null : parsed;
}

function isTokenLikeKey(value) {
  return /(token|auth|session|sid|jwt|csrf|nonce|device|fingerprint|sign)/i.test(String(value ?? ''));
}

function previewDetails(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 240 ? `${value.slice(0, 240)}...` : value;
  }
  return value;
}

function collectTopEntries(map, limit = 20, formatter = (key, count) => ({ key, count })) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit)
    .map(([key, count]) => formatter(key, count));
}

function recommendation(type, severity, reason, actions = []) {
  return { type, severity, reason, actions };
}

function cloneList(value, limit = 20) {
  return Array.isArray(value) ? value.slice(0, limit).map((entry) => ({ ...entry })) : [];
}

export function buildResultIdentitySnapshot({ request = {}, response = {}, result = {} } = {}) {
  const headers = request.headers && typeof request.headers === 'object' ? request.headers : {};
  const identity = request.identity && typeof request.identity === 'object' ? request.identity : {};
  const applied = response.debug?.identity && typeof response.debug.identity === 'object'
    ? response.debug.identity
    : null;
  const consistency = request._identityConsistency && typeof request._identityConsistency === 'object'
    ? request._identityConsistency
    : null;
  const configuredUserAgent = headers['user-agent'] ?? headers['User-Agent'] ?? null;
  const configuredAcceptLanguage = headers['accept-language'] ?? headers['Accept-Language'] ?? identity.acceptLanguage ?? null;
  const configuredTlsProfile = request.tlsProfile ?? null;
  const configuredH2Profile = getH2ProfileName(request.h2Profile);

  const parity = applied
    ? {
        userAgentMatches:
          applied.userAgent == null || configuredUserAgent == null
            ? null
            : String(applied.userAgent) === String(configuredUserAgent),
        acceptLanguageMatches:
          applied.acceptLanguage == null || configuredAcceptLanguage == null
            ? null
            : String(applied.acceptLanguage) === String(configuredAcceptLanguage),
        tlsProfileMatches:
          applied.tlsProfile == null || configuredTlsProfile == null
            ? null
            : String(applied.tlsProfile) === String(configuredTlsProfile),
        h2ProfileMatches:
          applied.h2Profile == null || configuredH2Profile == null
            ? null
            : String(applied.h2Profile) === String(configuredH2Profile),
      }
    : null;
  return {
    sessionId: result.sessionId ?? request.session?.id ?? null,
    proxyServer: result.proxyServer ?? request.proxy?.server ?? null,
    proxyLabel: result.proxyLabel ?? request.proxy?.label ?? null,
    tlsProfile: configuredTlsProfile,
    h2Profile: configuredH2Profile,
    userAgent: configuredUserAgent,
    acceptLanguage: configuredAcceptLanguage,
    locale: identity.locale ?? null,
    timezoneId: identity.timezoneId ?? null,
    bundleId: identity.bundleId ?? null,
    browserBackend: response.backend ?? null,
    browserBackendFamily: response.backendFamily ?? null,
    requestedEngine: response.requestedEngine ?? null,
    applied: applied
      ? {
          seed: applied.seed ?? null,
          userAgent: applied.userAgent ?? null,
          acceptLanguage: applied.acceptLanguage ?? null,
          locale: applied.locale ?? null,
          languages: Array.isArray(applied.languages) ? [...applied.languages] : [],
          platform: applied.platform ?? null,
          vendor: applied.vendor ?? null,
          deviceMemory: applied.deviceMemory ?? null,
          hardwareConcurrency: applied.hardwareConcurrency ?? null,
          maxTouchPoints: applied.maxTouchPoints ?? null,
          tlsProfile: applied.tlsProfile ?? null,
          h2Profile: applied.h2Profile ?? null,
        }
      : null,
    parity,
    consistency: consistency
      ? {
          driftCount: Number(consistency.driftCount ?? 0),
          correctionCount: Number(consistency.correctionCount ?? 0),
          driftFields: Array.isArray(consistency.driftFields) ? [...new Set(consistency.driftFields)] : [],
          correctionFields: Array.isArray(consistency.correctionFields) ? [...new Set(consistency.correctionFields)] : [],
          unsupported: cloneList(consistency.unsupported, 10),
          drifts: cloneList(consistency.drifts, 10),
          corrections: cloneList(consistency.corrections, 10),
        }
      : null,
  };
}

export function inspectResultDiagnostics({ request = {}, response = {}, extracted = {}, quality = {} } = {}) {
  const status = Number(response.status ?? 0);
  const text = lowerText(response.body);
  const hookEvents = response.debug?.hooks?.events ?? [];
  const publicEntries = Object.entries(extracted ?? {}).filter(([key]) => key !== '_meta');
  const nonEmptyFieldCount = publicEntries.filter(([, value]) => !isEmptyValue(value)).length;
  const challengeLikely = quality?.waf?.challengeLikely === true || response._challengeSolved === true;
  const authWallLikely =
    [401, 403].includes(status)
    && (
      text.includes('sign in')
      || text.includes('login')
      || text.includes('unauthorized')
      || text.includes('access token')
      || text.includes('session expired')
      || text.includes('forbidden')
    );
  const signatureLikely =
    status >= 400
    && (
      text.includes('invalid signature')
      || text.includes('signature error')
      || text.includes('bad signature')
      || text.includes('invalid token')
      || text.includes('token expired')
      || text.includes('timestamp expired')
      || text.includes('nonce')
    );
  const emptySuccessLikely =
    status > 0
    && status < 400
    && nonEmptyFieldCount === 0
    && (
      quality?.schema?.valid === false
      || text.includes('verify you are human')
      || text.includes('enable javascript')
      || text.includes('access denied')
      || text.includes('login')
      || text.includes('captcha')
    );
  const runtimeSignals = {
    wasmLikely:
      text.includes('.wasm')
      || text.includes('webassembly')
      || hookEvents.some((event) => String(event.type ?? '').startsWith('webassembly.')),
    webCryptoLikely:
      text.includes('crypto.subtle')
      || text.includes('subtle.encrypt')
      || text.includes('subtle.decrypt')
      || hookEvents.some((event) => String(event.type ?? '').startsWith('crypto.subtle.')),
    iframeLikely:
      text.includes('<iframe')
      || text.includes('postmessage')
      || text.includes('contentwindow')
      || hookEvents.some((event) => String(event.type ?? '').startsWith('iframe.') || String(event.type ?? '').includes('postMessage')),
  };
  const identityConsistency = request._identityConsistency && typeof request._identityConsistency === 'object'
    ? request._identityConsistency
    : null;
  const identityDriftDetected = Number(identityConsistency?.driftCount ?? 0) > 0;
  const identityCorrectionApplied = Number(identityConsistency?.correctionCount ?? 0) > 0;
  const browserIdentityParity = response.debug?.identity?.parity && typeof response.debug.identity.parity === 'object'
    ? response.debug.identity.parity
    : null;
  const browserIdentityMismatchCount = browserIdentityParity
    ? Object.values(browserIdentityParity).filter((value) => value === false).length
    : 0;

  let primaryClass = 'ok';
  if (challengeLikely) {
    primaryClass = 'anti-bot';
  } else if (authWallLikely) {
    primaryClass = 'auth';
  } else if (signatureLikely) {
    primaryClass = 'signature';
  } else if ((identityDriftDetected && !identityCorrectionApplied) || browserIdentityMismatchCount > 0) {
    primaryClass = 'identity';
  } else if (emptySuccessLikely) {
    primaryClass = 'degraded-success';
  }

  return {
    primaryClass,
    challengeDetected: quality?.waf?.detected === true || challengeLikely,
    challengeSolved: response._challengeSolved === true,
    challengeType: response._challengeType ?? null,
    authWallLikely,
    signatureLikely,
    emptySuccessLikely,
    identityDriftDetected,
    identityCorrectionApplied,
    browserIdentityMismatchCount,
    nonEmptyFieldCount,
    runtimeSignals,
  };
}

function buildStateSnapshot(results = [], summary = {}) {
  const bindings = new Map();
  const sessions = new Map();
  const proxies = new Map();
  const tlsProfiles = new Map();
  const h2Profiles = new Map();
  const userAgents = new Map();
  const browserBackends = new Map();
  const appliedSeeds = new Map();
  const browserParityMismatches = new Map();
  const identityDriftFields = new Map();
  const identityCorrectionFields = new Map();
  const identityUnsupported = new Map();
  let identityDriftCount = 0;
  let identityCorrectionCount = 0;
  let identityUnsupportedCount = 0;

  for (const result of results) {
    const identity = result.identity ?? {};
    const bindingKey = JSON.stringify([
      identity.sessionId ?? null,
      identity.proxyServer ?? null,
      identity.tlsProfile ?? null,
      identity.h2Profile ?? null,
      identity.userAgent ?? null,
      identity.browserBackend ?? null,
    ]);
    bindings.set(bindingKey, (bindings.get(bindingKey) ?? 0) + 1);

    if (identity.sessionId) {
      if (!sessions.has(identity.sessionId)) {
        sessions.set(identity.sessionId, new Set());
      }
      if (identity.proxyServer) {
        sessions.get(identity.sessionId).add(identity.proxyServer);
      }
    }
    if (identity.proxyServer) {
      proxies.set(identity.proxyServer, (proxies.get(identity.proxyServer) ?? 0) + 1);
    }
    if (identity.tlsProfile) {
      tlsProfiles.set(identity.tlsProfile, (tlsProfiles.get(identity.tlsProfile) ?? 0) + 1);
    }
    if (identity.h2Profile) {
      h2Profiles.set(identity.h2Profile, (h2Profiles.get(identity.h2Profile) ?? 0) + 1);
    }
    if (identity.userAgent) {
      userAgents.set(identity.userAgent, (userAgents.get(identity.userAgent) ?? 0) + 1);
    }
    if (identity.browserBackend) {
      browserBackends.set(identity.browserBackend, (browserBackends.get(identity.browserBackend) ?? 0) + 1);
    }
    if (identity.applied?.seed !== null && identity.applied?.seed !== undefined) {
      appliedSeeds.set(String(identity.applied.seed), (appliedSeeds.get(String(identity.applied.seed)) ?? 0) + 1);
    }
    for (const [field, value] of Object.entries(identity.parity ?? {})) {
      if (value === false) {
        browserParityMismatches.set(field, (browserParityMismatches.get(field) ?? 0) + 1);
      }
    }

    const consistency = identity.consistency ?? {};
    identityDriftCount += Number(consistency.driftCount ?? 0);
    identityCorrectionCount += Number(consistency.correctionCount ?? 0);
    identityUnsupportedCount += Array.isArray(consistency.unsupported) ? consistency.unsupported.length : 0;
    for (const field of consistency.driftFields ?? []) {
      identityDriftFields.set(field, (identityDriftFields.get(field) ?? 0) + 1);
    }
    for (const field of consistency.correctionFields ?? []) {
      identityCorrectionFields.set(field, (identityCorrectionFields.get(field) ?? 0) + 1);
    }
    for (const entry of consistency.unsupported ?? []) {
      const key = String(entry.field ?? 'unknown');
      identityUnsupported.set(key, (identityUnsupported.get(key) ?? 0) + 1);
    }
  }

  const unstableSessions = [...sessions.entries()]
    .filter(([, proxySet]) => proxySet.size > 1)
    .map(([sessionId, proxySet]) => ({
      sessionId,
      proxies: [...proxySet].sort(),
    }));

  const attributedBindings = collectTopEntries(bindings, 10, (key, count) => {
    const [sessionId, proxyServer, tlsProfile, h2Profile, userAgent, browserBackend] = JSON.parse(key);
    const matchingResults = results.filter((result) => {
      const identity = result.identity ?? {};
      return (
        (identity.sessionId ?? null) === sessionId
        && (identity.proxyServer ?? null) === proxyServer
        && (identity.tlsProfile ?? null) === tlsProfile
        && (identity.h2Profile ?? null) === h2Profile
        && (identity.userAgent ?? null) === userAgent
        && (identity.browserBackend ?? null) === browserBackend
      );
    });
    return {
      count,
      sessionId,
      proxyServer,
      tlsProfile,
      h2Profile,
      userAgent,
      browserBackend,
      successCount: matchingResults.filter((result) => Number(result.status ?? 0) > 0 && Number(result.status ?? 0) < 400).length,
      nonOkCount: matchingResults.filter((result) => Number(result.status ?? 0) >= 400).length,
      challengeCount: matchingResults.filter((result) => result.diagnostics?.challengeDetected === true).length,
      signatureLikelyCount: matchingResults.filter((result) => result.diagnostics?.signatureLikely === true).length,
    };
  });

  return {
    bindingCount: bindings.size,
    topBindings: attributedBindings,
    sessions: {
      configured: summary.sessions ?? null,
      distinctCount: sessions.size,
      unstableBindings: unstableSessions,
    },
    proxies: {
      distinctCount: proxies.size,
      top: collectTopEntries(proxies, 10, (proxyServer, count) => ({ proxyServer, count })),
    },
    fingerprints: {
      tlsProfiles: collectTopEntries(tlsProfiles, 10, (profile, count) => ({ profile, count })),
      h2Profiles: collectTopEntries(h2Profiles, 10, (profile, count) => ({ profile, count })),
      userAgents: collectTopEntries(userAgents, 5, (userAgent, count) => ({ userAgent, count })),
      browserBackends: collectTopEntries(browserBackends, 10, (backend, count) => ({ backend, count })),
      appliedSeeds: collectTopEntries(appliedSeeds, 10, (seed, count) => ({ seed, count })),
      browserParityMismatches: collectTopEntries(browserParityMismatches, 10, (field, count) => ({ field, count })),
    },
    identityConsistency: {
      driftCount: identityDriftCount,
      correctionCount: identityCorrectionCount,
      unsupportedCount: identityUnsupportedCount,
      driftFields: collectTopEntries(identityDriftFields, 10, (field, count) => ({ field, count })),
      correctionFields: collectTopEntries(identityCorrectionFields, 10, (field, count) => ({ field, count })),
      unsupported: collectTopEntries(identityUnsupported, 10, (field, count) => ({ field, count })),
    },
  };
}

function buildAuthSnapshot(results = []) {
  const storageKeys = new Map();
  const cookieNames = new Map();
  let authHeaderCount = 0;
  let loginWallCount = 0;
  let expiredSessionCount = 0;

  for (const result of results) {
    if (result.diagnostics?.authWallLikely) {
      loginWallCount += 1;
    }

    const bodyText = lowerText(result.responseBody ?? result.body ?? '');
    if (bodyText.includes('session expired') || bodyText.includes('token expired') || bodyText.includes('expired token')) {
      expiredSessionCount += 1;
    }

    for (const request of result.debug?.requests ?? []) {
      const headers = request.requestHeaders ?? {};
      if (headers.authorization || headers.Authorization) {
        authHeaderCount += 1;
      }

      const responseHeaders = request.responseHeaders ?? {};
      const setCookieHeader = responseHeaders['set-cookie'] ?? responseHeaders['Set-Cookie'] ?? null;
      const rawValues = Array.isArray(setCookieHeader) ? setCookieHeader : setCookieHeader ? [setCookieHeader] : [];
      for (const raw of rawValues) {
        const name = String(raw).split('=')[0]?.trim();
        if (name) {
          cookieNames.set(name, (cookieNames.get(name) ?? 0) + 1);
        }
      }
    }

    for (const event of result.debug?.hooks?.events ?? []) {
      if (!String(event.type ?? '').startsWith('localStorage.') && !String(event.type ?? '').startsWith('sessionStorage.')) {
        continue;
      }
      const key = String(event.key ?? '').trim();
      if (!key) {
        continue;
      }
      storageKeys.set(key, (storageKeys.get(key) ?? 0) + 1);
    }
  }

  const tokenLikeStorageKeys = [...storageKeys.entries()]
    .filter(([key]) => isTokenLikeKey(key))
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));

  return {
    authHeaderCount,
    loginWallCount,
    expiredSessionCount,
    topCookieNames: collectTopEntries(cookieNames, 20, (name, count) => ({ name, count })),
    topStorageKeys: collectTopEntries(storageKeys, 20, (key, count) => ({ key, count })),
    tokenLikeStorageKeys,
  };
}

function buildSurfaceSnapshot(results = []) {
  const scripts = new Map();
  const endpoints = new Map();
  const hookTypes = new Map();
  let wasmSignalCount = 0;
  let webCryptoSignalCount = 0;
  let iframeSignalCount = 0;

  for (const result of results) {
    if (result.diagnostics?.runtimeSignals?.wasmLikely) {
      wasmSignalCount += 1;
    }
    if (result.diagnostics?.runtimeSignals?.webCryptoLikely) {
      webCryptoSignalCount += 1;
    }
    if (result.diagnostics?.runtimeSignals?.iframeLikely) {
      iframeSignalCount += 1;
    }

    for (const script of result.debug?.scripts ?? []) {
      const identifier = script.url ?? script.sourceURL ?? hashText(script.sourcePreview ?? JSON.stringify(script));
      scripts.set(identifier, (scripts.get(identifier) ?? 0) + 1);
      const preview = lowerText(script.sourcePreview, 2_000);
      if (preview.includes('.wasm') || preview.includes('webassembly')) {
        wasmSignalCount += 1;
      }
      if (preview.includes('crypto.subtle') || preview.includes('subtle.encrypt') || preview.includes('subtle.decrypt')) {
        webCryptoSignalCount += 1;
      }
      if (preview.includes('postmessage') || preview.includes('contentwindow') || preview.includes('iframe')) {
        iframeSignalCount += 1;
      }
    }

    for (const request of result.debug?.requests ?? []) {
      const endpoint = normalizeEndpoint(request.url);
      if (endpoint) {
        endpoints.set(endpoint, (endpoints.get(endpoint) ?? 0) + 1);
      }
    }

    for (const event of result.debug?.hooks?.events ?? []) {
      const type = String(event.type ?? '').trim();
      if (!type) {
        continue;
      }
      hookTypes.set(type, (hookTypes.get(type) ?? 0) + 1);
      if (type.startsWith('webassembly.')) {
        wasmSignalCount += 1;
      }
      if (type.startsWith('crypto.subtle.')) {
        webCryptoSignalCount += 1;
      }
      if (type.startsWith('iframe.') || type.includes('postMessage')) {
        iframeSignalCount += 1;
      }
    }
  }

  return {
    scriptInventoryCount: scripts.size,
    endpointInventoryCount: endpoints.size,
    topScripts: collectTopEntries(scripts, 20, (script, count) => ({ script, count })),
    topEndpoints: collectTopEntries(endpoints, 20, (endpoint, count) => ({ endpoint, count })),
    topHookTypes: collectTopEntries(hookTypes, 20, (type, count) => ({ type, count })),
    runtimeSignals: {
      wasmSignalCount,
      webCryptoSignalCount,
      iframeSignalCount,
    },
  };
}

function classifyHookPhase(type) {
  if (type.startsWith('crypto.subtle.') || type.startsWith('webassembly.') || type === 'atob' || type === 'btoa') {
    return 'signer-runtime';
  }
  if (type.startsWith('iframe.') || type.includes('postMessage')) {
    return 'bridge-runtime';
  }
  if (type.startsWith('localStorage.') || type.startsWith('sessionStorage.')) {
    return 'state-runtime';
  }
  if (type.startsWith('fetch.') || type.startsWith('xhr.')) {
    return 'network-runtime';
  }
  return 'runtime';
}

function buildSignatureTimeline(results = [], limit = 200) {
  const entries = [];

  for (const result of results) {
    const resultKey = `${result.url}|${result.sequence ?? 0}`;
    for (const request of result.debug?.requests ?? []) {
      const at = request.startedAt ?? request.finishedAt ?? result.fetchedAt ?? null;
      entries.push({
        at,
        ts: parseTime(at) ?? Number.MAX_SAFE_INTEGER,
        scope: 'network',
        phase: 'request-chain',
        resultKey,
        url: result.url,
        finalUrl: result.finalUrl,
        requestUrl: request.url,
        transport: request.transport ?? null,
        method: request.method ?? null,
        status: request.status ?? null,
      });
    }

    for (const event of result.debug?.hooks?.events ?? []) {
      const type = String(event.type ?? '').trim();
      if (!type) {
        continue;
      }
      if (!(
        type === 'atob'
        || type === 'btoa'
        || type.startsWith('crypto.subtle.')
        || type.startsWith('webassembly.')
        || type.startsWith('iframe.')
        || type.includes('postMessage')
        || type.startsWith('localStorage.')
        || type.startsWith('sessionStorage.')
        || type.startsWith('fetch.')
        || type.startsWith('xhr.')
      )) {
        continue;
      }

      const at = event.at ?? result.fetchedAt ?? null;
      entries.push({
        at,
        ts: parseTime(at) ?? Number.MAX_SAFE_INTEGER,
        scope: 'hook',
        phase: classifyHookPhase(type),
        resultKey,
        url: result.url,
        finalUrl: result.finalUrl,
        type,
        requestUrl: event.url ?? null,
        method: event.method ?? null,
        status: event.status ?? null,
        key: event.key ?? null,
        details: previewDetails(event.input ?? event.result ?? event.value ?? event.targetOrigin ?? null),
      });
    }
  }

  return entries
    .sort((left, right) => left.ts - right.ts || String(left.type ?? left.requestUrl ?? '').localeCompare(String(right.type ?? right.requestUrl ?? '')))
    .slice(0, limit)
    .map(({ ts, ...entry }) => entry);
}

function buildSignatureChains(results = [], limit = 20) {
  return results
    .map((result) => {
      const timeline = buildSignatureTimeline([result], 40);
      const runtimeCount = timeline.filter((entry) => entry.scope === 'hook' && (entry.phase === 'signer-runtime' || entry.phase === 'bridge-runtime')).length;
      const networkCount = timeline.filter((entry) => entry.scope === 'network' || entry.phase === 'network-runtime').length;
      return {
        url: result.url,
        finalUrl: result.finalUrl,
        status: result.status,
        primaryClass: result.diagnostics?.primaryClass ?? 'ok',
        runtimeCount,
        networkCount,
        timeline,
      };
    })
    .filter((entry) => entry.timeline.length > 0)
    .sort((left, right) => (right.runtimeCount + right.networkCount) - (left.runtimeCount + left.networkCount))
    .slice(0, limit);
}

function buildSignalsSnapshot(summary = {}, results = []) {
  const primaryClasses = new Map();
  let challengeSolvedCount = 0;
  let signatureLikelyCount = 0;
  let authWallCount = 0;
  let emptySuccessCount = 0;
  let retryHeavyCount = 0;
  let nonOkCount = 0;
  let identityDriftCount = 0;
  let identityCorrectionCount = 0;

  for (const result of results) {
    const diagnostics = result.diagnostics ?? {};
    primaryClasses.set(diagnostics.primaryClass ?? 'ok', (primaryClasses.get(diagnostics.primaryClass ?? 'ok') ?? 0) + 1);
    if (diagnostics.challengeSolved) {
      challengeSolvedCount += 1;
    }
    if (diagnostics.signatureLikely) {
      signatureLikelyCount += 1;
    }
    if (diagnostics.authWallLikely) {
      authWallCount += 1;
    }
    if (diagnostics.emptySuccessLikely) {
      emptySuccessCount += 1;
    }
    if (Number(result.attemptsUsed ?? 0) > 1) {
      retryHeavyCount += 1;
    }
    if (Number(result.status ?? 0) >= 400) {
      nonOkCount += 1;
    }
    identityDriftCount += Number(result.identity?.consistency?.driftCount ?? 0);
    identityCorrectionCount += Number(result.identity?.consistency?.correctionCount ?? 0);
  }

  return {
    resultCount: results.length,
    failureCount: summary.failureCount ?? 0,
    challengeCount: summary.quality?.waf?.challengedCount ?? 0,
    challengeSolvedCount,
    wafDetectedCount: summary.quality?.waf?.detectedCount ?? 0,
    signatureLikelyCount,
    authWallCount,
    emptySuccessCount,
    schemaInvalidCount: summary.quality?.schema?.invalidRecordCount ?? 0,
    changedResultCount: summary.changeTracking?.changedResultCount ?? 0,
    nonOkCount,
    retryHeavyCount,
    identityDriftCount,
    identityCorrectionCount,
    primaryClasses: collectTopEntries(primaryClasses, 10, (type, count) => ({ type, count })),
  };
}

function buildSuspects(summary, state, surface, signals) {
  const suspects = [];
  const baselineAlertTypes = new Set((summary.baseline?.alerts ?? []).map((entry) => entry.type));

  if (signals.challengeCount > 0 || signals.wafDetectedCount > 0) {
    suspects.push({
      type: 'fingerprint-or-anti-bot',
      score: Math.min(100, 55 + (signals.challengeCount * 10) + (signals.challengeSolvedCount > 0 ? 5 : 0)),
      reason: 'Challenge-like responses or upstream protection markers were detected during the run.',
    });
  }

  if (signals.signatureLikelyCount > 0) {
    suspects.push({
      type: 'signature-or-parameter-chain',
      score: Math.min(100, 60 + (signals.signatureLikelyCount * 10)),
      reason: 'Response signatures suggest parameter generation, timestamp, nonce, or token signing drift.',
    });
  }

  if ((state.identityConsistency?.driftCount ?? 0) > 0) {
    suspects.push({
      type: 'identity-drift',
      score: Math.min(100, 45 + ((state.identityConsistency?.driftCount ?? 0) * 8) + ((state.identityConsistency?.correctionCount ?? 0) > 0 ? 5 : 0)),
      reason: 'Request identity fields drifted from the configured profile, which can silently break signer and anti-bot parity.',
    });
  }

  if (signals.authWallCount > 0) {
    suspects.push({
      type: 'auth-or-session-state',
      score: Math.min(100, 55 + (signals.authWallCount * 10)),
      reason: 'Responses suggest login/session gating or expired credentials in the request chain.',
    });
  }

  if (state.sessions.unstableBindings.length > 0) {
    suspects.push({
      type: 'state-binding-instability',
      score: Math.min(100, 65 + (state.sessions.unstableBindings.length * 10)),
      reason: 'The same session id appeared with multiple proxies, which often breaks device/session binding.',
    });
  }

  if ((summary.failureCount ?? 0) > 0 && (summary.resultCount ?? 0) === 0) {
    suspects.push({
      type: 'proxy-or-network-quality',
      score: Math.min(100, 55 + ((summary.failureCount ?? 0) * 10)),
      reason: 'The run failed before producing useful records, which often points at proxy, transport, or network quality issues.',
    });
  }

  if (
    signals.changedResultCount > 0
    || (summary.quality?.structure?.shapeVariantCount ?? 0) > 1
    || baselineAlertTypes.has('schema-regression')
    || baselineAlertTypes.has('field-type-change')
  ) {
    suspects.push({
      type: 'target-change-or-parser-drift',
      score: Math.min(100, 50 + (signals.changedResultCount * 10) + ((summary.quality?.structure?.shapeVariantCount ?? 0) > 1 ? 10 : 0)),
      reason: 'Observed content drift, field shape drift, or baseline schema regressions suggest target changes.',
    });
  }

  if (signals.emptySuccessCount > 0) {
    suspects.push({
      type: 'degraded-success',
      score: Math.min(100, 45 + (signals.emptySuccessCount * 10)),
      reason: 'The target returned nominally successful responses with empty or degraded payloads.',
    });
  }

  if (surface.runtimeSignals.wasmSignalCount > 0 || surface.runtimeSignals.webCryptoSignalCount > 0) {
    suspects.push({
      type: 'runtime-signature-hardening',
      score: Math.min(100, 40 + (surface.runtimeSignals.wasmSignalCount * 5) + (surface.runtimeSignals.webCryptoSignalCount * 5)),
      reason: 'The reverse surface shows WASM/WebCrypto signals that usually mean runtime-only signing logic.',
    });
  }

  return suspects.sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
}

function buildRecoveryRecommendations(suspects = []) {
  const recommendations = [];

  for (const suspect of suspects.slice(0, 4)) {
    if (suspect.type === 'fingerprint-or-anti-bot') {
      recommendations.push(recommendation(
        suspect.type,
        'high',
        suspect.reason,
        [
          'Verify TLS, HTTP/2, header order, locale, timezone, and browser backend align with the intended browser profile.',
          'Compare challenged requests in reverse-lab against successful browser traffic before changing extraction code.',
          'Check whether session, proxy, and user-agent stayed bound together across the full request chain.',
        ],
      ));
    } else if (suspect.type === 'signature-or-parameter-chain') {
      recommendations.push(recommendation(
        suspect.type,
        'high',
        suspect.reason,
        [
          'Trace the request initiator chain in reverse-lab and inspect dynamic token generation before replaying the final API request.',
          'Prioritize runtime hooks around WebCrypto, WASM, and signer callsites instead of static string search alone.',
          'Capture preflight/home/config/bootstrap requests together with cookies and storage mutations, not just the failing API call.',
        ],
      ));
    } else if (suspect.type === 'auth-or-session-state') {
      recommendations.push(recommendation(
        suspect.type,
        'high',
        suspect.reason,
        [
          'Verify login/bootstrap steps and ensure cookies, localStorage, and in-memory tokens are captured in sequence.',
          'Avoid moving a live session across proxies or device fingerprints after initialization.',
          'Add explicit checks for login-wall HTML and expired-session payloads so false-success pages are flagged immediately.',
        ],
      ));
    } else if (suspect.type === 'identity-drift') {
      recommendations.push(recommendation(
        suspect.type,
        'high',
        suspect.reason,
        [
          'Pin user-agent, accept-language, TLS profile, and HTTP/2 profile from one canonical identity config instead of setting them ad hoc per request.',
          'Review middleware/plugins that mutate headers after request construction and make sure they do not fork the identity tuple mid-run.',
          'Treat identity corrections as a signal to tighten configuration, not as a substitute for a stable target fingerprint strategy.',
        ],
      ));
    } else if (suspect.type === 'state-binding-instability') {
      recommendations.push(recommendation(
        suspect.type,
        'medium',
        suspect.reason,
        [
          'Bind each session to one proxy and one fingerprint tuple for the whole run.',
          'Review session pool rotation and retry behavior to ensure retries do not silently switch identities mid-chain.',
          'Treat proxy/session rebinding as a controlled recovery action, not a default retry behavior.',
        ],
      ));
    } else if (suspect.type === 'proxy-or-network-quality') {
      recommendations.push(recommendation(
        suspect.type,
        'medium',
        suspect.reason,
        [
          'Probe proxy health and compare failures by proxy server before changing signer logic.',
          'Inspect connection-level failures, non-HTTP resets, and status retry patterns to separate transport issues from app logic.',
          'Reduce concurrency temporarily and verify whether the same request succeeds on direct or alternate proxy routes.',
        ],
      ));
    } else if (suspect.type === 'target-change-or-parser-drift') {
      recommendations.push(recommendation(
        suspect.type,
        'medium',
        suspect.reason,
        [
          'Diff changed fields, debug script inventory, and network endpoints against the previous healthy run.',
          'Review extraction selectors/JSON paths and re-run reverse workflow analysis if signer-related assets changed.',
          'Use baseline and change-feed artifacts to isolate whether the break came from markup drift or request authorization drift.',
        ],
      ));
    } else if (suspect.type === 'degraded-success') {
      recommendations.push(recommendation(
        suspect.type,
        'medium',
        suspect.reason,
        [
          'Add assertions for required fields and login/challenge markers so empty-success responses fail fast.',
          'Inspect response bodies with browser debug artifacts to confirm whether the page is a degraded shell, login wall, or challenge.',
        ],
      ));
    } else if (suspect.type === 'runtime-signature-hardening') {
      recommendations.push(recommendation(
        suspect.type,
        'medium',
        suspect.reason,
        [
          'Instrument signer execution in-browser and capture WebAssembly / WebCrypto callsites before attempting static porting.',
          'Treat runtime parity as mandatory for this target and prefer browser-execute / reverse-lab over pure HTTP replay.',
        ],
      ));
    }
  }

  return recommendations;
}

function determineReplayMode({ surface, signals, suspects }) {
  const suspectTypes = new Set((suspects ?? []).map((entry) => entry.type));
  if (
    suspectTypes.has('runtime-signature-hardening')
    || suspectTypes.has('fingerprint-or-anti-bot')
    || (surface?.runtimeSignals?.wasmSignalCount ?? 0) > 0
    || (surface?.runtimeSignals?.webCryptoSignalCount ?? 0) > 0
    || (signals?.challengeCount ?? 0) > 0
  ) {
    return 'browser';
  }

  if (
    suspectTypes.has('signature-or-parameter-chain')
    || suspectTypes.has('auth-or-session-state')
    || (signals?.signatureLikelyCount ?? 0) > 0
    || (signals?.authWallCount ?? 0) > 0
  ) {
    return 'hybrid';
  }

  return 'http';
}

function buildReplayRationale({ recommendedMode, suspects = [], signals = {}, surface = {}, state = {} }) {
  const lines = [];

  if (recommendedMode === 'browser') {
    lines.push('Target behavior depends on browser runtime parity, anti-bot posture, or signer execution surfaces.');
  } else if (recommendedMode === 'hybrid') {
    lines.push('Replay likely needs browser bootstrap/state capture before handing the steady-state traffic to HTTP.');
  } else {
    lines.push('Observed traffic can likely be replayed directly over HTTP once the same identity tuple is preserved.');
  }

  if ((signals.signatureLikelyCount ?? 0) > 0) {
    lines.push('Signature-like failures were observed, so bootstrap requests and signer-adjacent state must be captured in sequence.');
  }
  if ((surface.runtimeSignals?.webCryptoSignalCount ?? 0) > 0 || (surface.runtimeSignals?.wasmSignalCount ?? 0) > 0) {
    lines.push('WebCrypto/WASM activity suggests runtime-only signer logic that should be instrumented before porting.');
  }
  if ((state.sessions?.unstableBindings?.length ?? 0) > 0) {
    lines.push('Session-to-proxy bindings were unstable, so replay must keep the identity tuple pinned end-to-end.');
  }
  if ((state.identityConsistency?.driftCount ?? 0) > 0) {
    lines.push('Configured identity fields drifted during request construction, so replay should start from one canonical identity bundle and avoid per-request overrides.');
  }
  if (suspects.some((entry) => entry.type === 'fingerprint-or-anti-bot')) {
    lines.push('Anti-bot markers were detected, so fingerprint drift is a likely breakage source.');
  }

  return [...new Set(lines)];
}

function buildReplayPrerequisites({ recommendedMode, state = {}, surface = {}, signals = {} }) {
  const prerequisites = [];

  if (recommendedMode !== 'http') {
    prerequisites.push('Prepare a browser lane with the same locale, timezone, user-agent, and backend family used by the healthy run.');
  }
  prerequisites.push('Bind one session to one proxy/fingerprint tuple for the whole bootstrap and replay chain.');

  if ((signals.signatureLikelyCount ?? 0) > 0) {
    prerequisites.push('Capture bootstrap requests, cookies, storage mutations, and signer-adjacent hook events before replaying the terminal API call.');
  }
  if ((state.identityConsistency?.driftCount ?? 0) > 0) {
    prerequisites.push('Freeze user-agent, accept-language, TLS profile, and HTTP/2 profile before replaying any signed request chain.');
  }
  if ((surface.runtimeSignals?.webCryptoSignalCount ?? 0) > 0 || (surface.runtimeSignals?.wasmSignalCount ?? 0) > 0) {
    prerequisites.push('Instrument WebCrypto/WASM callsites in-browser before attempting any static signer port.');
  }
  if ((state.auth?.tokenLikeStorageKeys?.length ?? 0) > 0) {
    prerequisites.push('Persist token-like storage keys together with cookies so token refresh order is preserved.');
  }

  return prerequisites;
}

function buildReplaySteps({ recommendedMode, state = {}, surface = {}, timeline = [], chains = [] }) {
  const steps = [
    {
      phase: 'identity',
      action: 'Pin the identity tuple',
      details: {
        sessionBoundToProxy: true,
        unstableBindings: state.sessions?.unstableBindings ?? [],
        tlsProfiles: state.fingerprints?.tlsProfiles ?? [],
        h2Profiles: state.fingerprints?.h2Profiles ?? [],
        browserBackends: state.fingerprints?.browserBackends ?? [],
      },
    },
  ];

  if (recommendedMode !== 'http') {
    steps.push({
      phase: 'bootstrap',
      action: 'Reproduce bootstrap in browser first',
      details: {
        topEndpoints: (surface.topEndpoints ?? []).slice(0, 10),
        topHookTypes: (surface.topHookTypes ?? []).slice(0, 10),
        tokenLikeStorageKeys: (state.auth?.tokenLikeStorageKeys ?? []).slice(0, 10),
        cookieNames: (state.auth?.topCookieNames ?? []).slice(0, 10),
      },
    });
  }

  steps.push({
    phase: 'signer-chain',
    action: recommendedMode === 'browser' ? 'Replay signer execution in-browser' : 'Capture signer inputs before HTTP replay',
    details: {
      timeline: timeline.slice(0, 12),
      chains: chains.slice(0, 5),
    },
  });

  steps.push({
    phase: 'steady-state',
    action: recommendedMode === 'http' ? 'Replay target requests over HTTP' : 'Attempt HTTP downgrade only after bootstrap state stabilizes',
    details: {
      preserveHeaders: ['user-agent', 'authorization', 'x-requested-with'],
      preserveState: ['cookies', 'localStorage', 'sessionStorage', 'nonce/timestamp/token params'],
    },
  });

  return steps;
}

export function buildReplayRecipe({ summary = {}, state = {}, surface = {}, signals = {}, suspects = [], recovery = [], timeline = [], chains = [] } = {}) {
  const recommendedMode = determineReplayMode({ surface, signals, suspects });

  return {
    version: 1,
    recommendedMode,
    rationale: buildReplayRationale({ recommendedMode, suspects, signals, surface, state }),
    prerequisites: buildReplayPrerequisites({ recommendedMode, state, surface, signals }),
    identity: {
      bindSessionToProxy: true,
      preserveTlsProfile: (state.fingerprints?.tlsProfiles?.length ?? 0) > 0,
      preserveH2Profile: (state.fingerprints?.h2Profiles?.length ?? 0) > 0,
      preserveUserAgent: (state.fingerprints?.userAgents?.length ?? 0) > 0,
      browserBackend: state.fingerprints?.browserBackends?.[0]?.backend ?? null,
    },
    capture: {
      topEndpoints: (surface.topEndpoints ?? []).slice(0, 20),
      topHookTypes: (surface.topHookTypes ?? []).slice(0, 20),
      tokenLikeStorageKeys: (state.auth?.tokenLikeStorageKeys ?? []).slice(0, 20),
      cookieNames: (state.auth?.topCookieNames ?? []).slice(0, 20),
    },
    steps: buildReplaySteps({ recommendedMode, state, surface, timeline, chains }),
    recovery: recovery.slice(0, 4),
    generatedFrom: {
      failureCount: summary.failureCount ?? 0,
      challengeCount: signals.challengeCount ?? 0,
      signatureLikelyCount: signals.signatureLikelyCount ?? 0,
      authWallCount: signals.authWallCount ?? 0,
    },
  };
}

export function analyzeRunDiagnostics({ summary = {}, results = [] } = {}) {
  const state = buildStateSnapshot(results, summary);
  state.auth = buildAuthSnapshot(results);
  const surface = buildSurfaceSnapshot(results);
  const signals = buildSignalsSnapshot(summary, results);
  const suspects = buildSuspects(summary, state, surface, signals);
  const timeline = buildSignatureTimeline(results);
  const chains = buildSignatureChains(results);
  const recovery = buildRecoveryRecommendations(suspects);

  return {
    state,
    surface,
    signals,
    suspects,
    timeline,
    chains,
    recovery,
    recipe: buildReplayRecipe({
      summary,
      state,
      surface,
      signals,
      suspects,
      recovery,
      timeline,
      chains,
    }),
  };
}
