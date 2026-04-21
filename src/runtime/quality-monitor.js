function toLowerHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    output[String(key).toLowerCase()] = Array.isArray(value)
      ? value.map((entry) => String(entry))
      : String(value ?? '');
  }
  return output;
}

function getHeader(headers, name) {
  return headers[String(name).toLowerCase()] ?? null;
}

function getHeaderValues(headers, name) {
  const value = getHeader(headers, name);
  if (value === null || value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function detectValueType(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value === 'object' ? 'object' : typeof value;
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

function signal(provider, source, detail) {
  return { provider, source, detail };
}

export function detectWafSurface({ headers = {}, body = '', status = 200, url = '' } = {}) {
  const normalizedHeaders = toLowerHeaders(headers);
  const text = String(body ?? '').slice(0, 12_000).toLowerCase();
  const server = String(getHeader(normalizedHeaders, 'server') ?? '').toLowerCase();
  const setCookies = getHeaderValues(normalizedHeaders, 'set-cookie').join('\n').toLowerCase();
  const signals = [];

  if (getHeader(normalizedHeaders, 'cf-ray') || server.includes('cloudflare') || text.includes('/cdn-cgi/challenge-platform/')) {
    signals.push(signal('cloudflare', 'header/body', 'cloudflare markers'));
  }
  if (text.includes('attention required') || text.includes('cf-chl') || setCookies.includes('__cf_bm')) {
    signals.push(signal('cloudflare', 'body/cookie', 'challenge markers'));
  }

  if (server.includes('akamaighost') || setCookies.includes('_abck') || setCookies.includes('bm_sv') || setCookies.includes('ak_bmsc')) {
    signals.push(signal('akamai', 'header/cookie', 'akamai bot manager markers'));
  }

  if (getHeader(normalizedHeaders, 'x-datadome') || setCookies.includes('datadome') || text.includes('datadome')) {
    signals.push(signal('datadome', 'header/body/cookie', 'datadome markers'));
  }

  if (server.includes('imperva') || setCookies.includes('incap_ses') || setCookies.includes('visid_incap')) {
    signals.push(signal('imperva', 'header/cookie', 'imperva/incapsula markers'));
  }

  if (server.includes('big-ip') || setCookies.includes('bigipserver') || text.includes('f5 distributed cloud')) {
    signals.push(signal('f5', 'header/body/cookie', 'f5 markers'));
  }

  if (server.includes('shape') || text.includes('perimeterx') || text.includes('_px3') || setCookies.includes('_px')) {
    signals.push(signal('shape-perimeterx', 'body/cookie', 'shape/perimeterx markers'));
  }

  const providerCounts = new Map();
  for (const entry of signals) {
    providerCounts.set(entry.provider, (providerCounts.get(entry.provider) ?? 0) + 1);
  }

  const rankedProviders = [...providerCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([provider, count]) => ({ provider, count }));

  const challengeLikely =
    status === 403
    || status === 429
    || text.includes('captcha')
    || text.includes('verify you are human')
    || text.includes('challenge')
    || text.includes('access denied');

  return {
    detected: rankedProviders.length > 0,
    provider: rankedProviders[0]?.provider ?? null,
    providers: rankedProviders,
    challengeLikely,
    action: rankedProviders.length > 0 ? 'review-target-protection' : 'none',
    url,
    status,
    signals,
  };
}

export function validateExtractedSchema(extracted = {}, schemaConfig = {}) {
  const required = Array.isArray(schemaConfig.required) ? schemaConfig.required : [];
  const types = schemaConfig.types && typeof schemaConfig.types === 'object' ? schemaConfig.types : {};
  const issues = [];

  for (const field of required) {
    const value = extracted[field];
    if (isEmptyValue(value)) {
      issues.push({
        type: 'missing-required-field',
        field,
        expected: 'non-empty',
        actual: detectValueType(value),
      });
    }
  }

  for (const [field, expectedType] of Object.entries(types)) {
    if (!(field in extracted)) {
      continue;
    }
    const actualType = detectValueType(extracted[field]);
    if (actualType !== expectedType) {
      issues.push({
        type: 'type-mismatch',
        field,
        expected: expectedType,
        actual: actualType,
      });
    }
  }

  return {
    configured: required.length > 0 || Object.keys(types).length > 0,
    valid: issues.length === 0,
    issues,
    issueCount: issues.length,
  };
}

export function assessResultQuality({ extracted = {}, response, workflow } = {}) {
  const schema = validateExtractedSchema(extracted, workflow?.quality?.schema ?? {});
  const waf = detectWafSurface({
    headers: response?.headers ?? {},
    body: response?.body ?? '',
    status: response?.status ?? 200,
    url: response?.finalUrl ?? response?.url ?? '',
  });

  return {
    schema,
    waf,
  };
}

export class QualityTracker {
  constructor(config = {}) {
    this.config = config;
    this.recordCount = 0;
    this.invalidRecordCount = 0;
    this.issueCount = 0;
    this.typeMismatchCount = 0;
    this.wafDetections = new Map();
    this.challengeCount = 0;
    this.fieldPresence = new Map();
    this.fieldTypes = new Map();
    this.shapeVariants = new Map();
  }

  add(result = {}) {
    this.recordCount += 1;
    const extracted = result.extracted && typeof result.extracted === 'object' ? result.extracted : {};
    const publicKeys = Object.keys(extracted).filter((key) => key !== '_meta').sort();
    const populatedKeys = publicKeys.filter((key) => !isEmptyValue(extracted[key]));
    const shapeKey = populatedKeys.join('|');
    this.shapeVariants.set(shapeKey, (this.shapeVariants.get(shapeKey) ?? 0) + 1);

    for (const key of publicKeys) {
      const value = extracted[key];
      if (!isEmptyValue(value)) {
        this.fieldPresence.set(key, (this.fieldPresence.get(key) ?? 0) + 1);
      }

      const actualType = detectValueType(value);
      if (!this.fieldTypes.has(key)) {
        this.fieldTypes.set(key, new Map());
      }
      const bucket = this.fieldTypes.get(key);
      bucket.set(actualType, (bucket.get(actualType) ?? 0) + 1);
    }

    const schemaIssues = result.quality?.schema?.issues ?? [];
    if (schemaIssues.length > 0) {
      this.invalidRecordCount += 1;
      this.issueCount += schemaIssues.length;
      this.typeMismatchCount += schemaIssues.filter((entry) => entry.type === 'type-mismatch').length;
    }

    const provider = result.quality?.waf?.provider;
    if (provider) {
      this.wafDetections.set(provider, (this.wafDetections.get(provider) ?? 0) + 1);
    }
    if (result.quality?.waf?.challengeLikely) {
      this.challengeCount += 1;
    }
  }

  snapshot({ failureCount = 0 } = {}) {
    const fieldCoverage = Object.fromEntries(
      [...this.fieldPresence.entries()].map(([field, count]) => [field, this.recordCount === 0 ? 0 : count / this.recordCount]),
    );
    const fieldTypes = Object.fromEntries(
      [...this.fieldTypes.entries()].map(([field, counts]) => [
        field,
        [...counts.entries()]
          .sort((left, right) => right[1] - left[1])
          .map(([type, count]) => ({ type, count })),
      ]),
    );
    const providers = [...this.wafDetections.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([provider, count]) => ({ provider, count }));
    const shapeVariants = [...this.shapeVariants.entries()]
      .filter(([shape]) => shape)
      .map(([shape, count]) => ({
        fields: shape ? shape.split('|') : [],
        count,
      }));

    const invalidRate = this.recordCount === 0 ? 0 : this.invalidRecordCount / this.recordCount;
    const failureRate = this.recordCount + failureCount === 0 ? 0 : failureCount / (this.recordCount + failureCount);
    const challengedRate = this.recordCount === 0 ? 0 : this.challengeCount / this.recordCount;
    const shapeDrift = shapeVariants.length > 1;
    const healthScore = Math.max(
      0,
      Math.round(
        100
        - (failureRate * 35)
        - (invalidRate * 30)
        - (challengedRate * 20)
        - (shapeDrift ? 10 : 0),
      ),
    );

    const alerts = [];
    if (providers.length > 0) {
      alerts.push({
        type: 'waf-detected',
        severity: this.challengeCount > 0 ? 'warning' : 'info',
        providers,
        message: 'Target shows upstream protection markers. Review adapters or request authorization-specific handling rather than bypass logic.',
      });
    }
    if (this.invalidRecordCount > 0) {
      alerts.push({
        type: 'schema-validation',
        severity: 'warning',
        invalidRecordCount: this.invalidRecordCount,
        issueCount: this.issueCount,
        message: 'Some extracted records do not satisfy the configured schema contract.',
      });
    }
    if (shapeDrift) {
      alerts.push({
        type: 'shape-drift',
        severity: 'warning',
        variants: shapeVariants.length,
        message: 'Extracted field shapes drifted within this run, which often signals target markup changes or inconsistent extraction rules.',
      });
    }

    return {
      healthScore,
      schema: {
        configured: Boolean(
          (this.config.schema?.required?.length ?? 0) > 0
          || Object.keys(this.config.schema?.types ?? {}).length > 0,
        ),
        invalidRecordCount: this.invalidRecordCount,
        issueCount: this.issueCount,
        typeMismatchCount: this.typeMismatchCount,
      },
      waf: {
        detectedCount: providers.reduce((sum, entry) => sum + entry.count, 0),
        challengedCount: this.challengeCount,
        providers,
      },
      structure: {
        shapeVariantCount: shapeVariants.length,
        shapeVariants,
        fieldCoverage,
        fieldTypes,
      },
      alerts,
    };
  }
}
