function lowerHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [String(key).toLowerCase(), value]),
  );
}

function getTextBody(payload = {}) {
  return [payload.body, payload.html, payload.text]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
}

function tryJson(value) {
  if (value && typeof value === 'object') {
    return value;
  }
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function extractCookieNames(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  return unique(values.map((entry) => String(entry ?? '').split(';')[0]?.split('=')[0]?.trim()));
}

function extractCookieValues(setCookie) {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie];
  const output = {};
  for (const entry of values) {
    const first = String(entry ?? '').split(';')[0] ?? '';
    const separatorIndex = first.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = first.slice(0, separatorIndex).trim();
    const value = first.slice(separatorIndex + 1).trim();
    if (name) {
      output[name] = value;
    }
  }
  return output;
}

function walkTokenFields(value, trail = [], output = {}) {
  if (value === null || value === undefined) return output;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkTokenFields(entry, [...trail, String(index)], output));
    return output;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      walkTokenFields(entry, [...trail, key], output);
    }
    return output;
  }
  const key = trail[trail.length - 1] ?? '';
  if (/(token|auth|session|csrf|nonce|bearer|jwt|refresh|api[_-]?key)/i.test(key)) {
    output[trail.join('.')] = value;
  }
  return output;
}

export function detectLoginWall(payload = {}) {
  const status = Number(payload.status ?? 200);
  const body = getTextBody(payload).toLowerCase();
  const headers = lowerHeaders(payload.headers);
  const reasons = [];

  if ([401, 403].includes(status)) {
    reasons.push(`status:${status}`);
  }
  if (/(sign in|log in|please login|please log in|登录后继续|请先登录|unauthorized|access denied)/i.test(body)) {
    reasons.push('login-copy');
  }
  if (/<input[^>]+type=["']password["']/i.test(body)) {
    reasons.push('password-field');
  }
  if (headers.location && /login|signin|auth/i.test(String(headers.location))) {
    reasons.push('login-redirect');
  }

  return {
    detected: reasons.length > 0,
    reasons,
  };
}

export function extractAuthArtifacts(payload = {}) {
  const headers = lowerHeaders(payload.headers);
  const bodyText = getTextBody(payload);
  const bodyJson = tryJson(payload.body ?? payload.responseBody ?? bodyText);
  const extracted = payload.extracted && typeof payload.extracted === 'object' ? payload.extracted : {};

  const hiddenFieldMatches = [...bodyText.matchAll(/<input[^>]+type=["']hidden["'][^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi)];
  const hiddenFields = Object.fromEntries(
    hiddenFieldMatches
      .filter(([, name]) => /(token|csrf|nonce|authenticity|state|session)/i.test(name))
      .map(([, name, value]) => [name, value]),
  );

  const headerTokens = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^(authorization|x-auth-token|x-csrf-token|x-api-key|set-cookie)$/i.test(key)) {
      headerTokens[key] = value;
    }
  }

  const tokenFields = {
    ...walkTokenFields(bodyJson ?? {}),
    ...walkTokenFields(extracted),
  };

  const cookieNames = extractCookieNames(headers['set-cookie'] ?? []);
  const cookieValues = extractCookieValues(headers['set-cookie'] ?? []);
  const csrfFields = Object.keys(hiddenFields).filter((name) => /csrf|authenticity|nonce|state/i.test(name));

  return {
    loginWall: detectLoginWall(payload),
    cookieNames,
    cookieValues,
    hiddenFields,
    csrfFields,
    headerTokens,
    tokenFields,
    refreshLikely: Object.keys(tokenFields).some((key) => /refresh/i.test(key))
      || /refresh[_-]?token/i.test(bodyText),
  };
}

export function buildAuthStatePlan(payload = {}) {
  const artifacts = extractAuthArtifacts(payload);
  const replayState = {
    ...artifacts.hiddenFields,
    ...artifacts.tokenFields,
  };

  const requiredHeaders = Object.fromEntries(
    Object.entries(artifacts.headerTokens)
      .filter(([key]) => key !== 'set-cookie')
      .map(([key, value]) => [key, value]),
  );

  return {
    kind: 'auth-state-plan',
    loginWallDetected: artifacts.loginWall.detected,
    loginWallReasons: artifacts.loginWall.reasons,
    sessionLikelyRequired: artifacts.cookieNames.length > 0 || artifacts.loginWall.detected,
    requiredCookies: artifacts.cookieNames,
    cookieValues: artifacts.cookieValues,
    requiredHeaders,
    replayState,
    refreshLikely: artifacts.refreshLikely,
    csrfFields: artifacts.csrfFields,
  };
}

function mergeObjects(base = {}, next = {}) {
  return {
    ...(base ?? {}),
    ...(next ?? {}),
  };
}

export function deriveAuthStatePlanFromResults(results = [], options = {}) {
  const normalizedResults = Array.isArray(results) ? results : [];
  const aggregated = {
    loginWallDetected: false,
    loginWallReasons: [],
    requiredCookies: [],
    cookieValues: {},
    requiredHeaders: {},
    replayState: {},
    refreshLikely: false,
    csrfFields: [],
  };

  for (const result of normalizedResults) {
    const derived = buildAuthStatePlan({
      status: result?.status,
      extracted: mergeObjects(result?.extracted, result?.replayState),
      body: result?.replayState,
    });

    aggregated.loginWallDetected = aggregated.loginWallDetected
      || derived.loginWallDetected
      || result?.diagnostics?.authWallLikely === true
      || /\/login|\/signin|\/auth/i.test(String(result?.finalUrl ?? result?.url ?? ''));
    aggregated.loginWallReasons = unique([
      ...aggregated.loginWallReasons,
      ...derived.loginWallReasons,
      ...(result?.diagnostics?.authWallLikely ? ['result-auth-wall'] : []),
      ...(/\/login|\/signin|\/auth/i.test(String(result?.finalUrl ?? result?.url ?? '')) ? ['login-url'] : []),
    ]);
    aggregated.requiredCookies = unique([
      ...aggregated.requiredCookies,
      ...derived.requiredCookies,
      ...Object.keys(result?.replayState ?? {}).filter((key) => /(cookie|session)/i.test(key)),
    ]);
    aggregated.cookieValues = mergeObjects(aggregated.cookieValues, derived.cookieValues);
    aggregated.requiredHeaders = mergeObjects(aggregated.requiredHeaders, derived.requiredHeaders);
    aggregated.replayState = mergeObjects(aggregated.replayState, result?.replayState);
    aggregated.replayState = mergeObjects(aggregated.replayState, derived.replayState);
    aggregated.refreshLikely = aggregated.refreshLikely || derived.refreshLikely || result?.diagnostics?.authWallLikely === true;
    aggregated.csrfFields = unique([...aggregated.csrfFields, ...derived.csrfFields]);
  }

  const replayState = aggregated.replayState;
  const tokenFields = walkTokenFields(replayState);
  const requiredHeaders = {
    ...aggregated.requiredHeaders,
    ...Object.fromEntries(
      Object.entries(replayState)
        .filter(([key]) => /^(authorization|x-auth-token|x-csrf-token|x-api-key)$/i.test(key))
        .map(([key, value]) => [key, value]),
    ),
  };

  return {
    kind: 'auth-state-plan',
    loginWallDetected: aggregated.loginWallDetected,
    loginWallReasons: aggregated.loginWallReasons,
    sessionLikelyRequired: aggregated.requiredCookies.length > 0 || aggregated.loginWallDetected,
    requiredCookies: aggregated.requiredCookies,
    cookieValues: aggregated.cookieValues,
    requiredHeaders,
    replayState,
    refreshLikely: aggregated.refreshLikely || Object.keys(tokenFields).some((key) => /refresh/i.test(key)),
    csrfFields: aggregated.csrfFields,
  };
}
