import esprima from 'esprima';
import estraverse from 'estraverse';
import { hashText } from '../utils/hash.js';
import { analyzeJavaScript } from './reverse-analyzer.js';
import { inferAllSignatureFunctions } from './signature-inferrer.js';
import { detectWaf } from './waf-bypass.js';

function unique(values) {
  return [...new Set((values ?? []).filter(Boolean))];
}

function limit(items, max = 20) {
  return Array.isArray(items) ? items.slice(0, max) : [];
}

function getString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function getObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function lowerHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
  );
}

function normalizeBody(payload = {}) {
  return getString(payload.body)
    || getString(payload.html)
    || getString(payload.content)
    || getString(payload.responseBody)
    || '';
}

function extractInlineScriptCode(html = '') {
  if (!html || typeof html !== 'string') {
    return '';
  }

  return Array.from(html.matchAll(/<script(?![^>]+src=)[^>]*>([\s\S]*?)<\/script>/gi))
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
}

function parseAst(source) {
  const options = {
    comment: true,
    loc: true,
    range: true,
    tolerant: true,
    jsx: true,
  };

  try {
    return esprima.parseModule(source, options);
  } catch {
    try {
      return esprima.parseScript(source, options);
    } catch {
      return null;
    }
  }
}

function nodeLabel(node) {
  if (!node) {
    return null;
  }

  switch (node.type) {
    case 'Identifier':
      return node.name;

    case 'Literal':
      return typeof node.value === 'string' ? node.value : String(node.value);

    case 'TemplateLiteral':
      return node.quasis.map((item) => item.value?.cooked ?? '').join('${...}');

    case 'MemberExpression': {
      const objectName = nodeLabel(node.object);
      const propertyName = node.computed ? nodeLabel(node.property) : node.property?.name;
      return objectName && propertyName ? `${objectName}.${propertyName}` : objectName ?? propertyName ?? null;
    }

    case 'CallExpression':
      return nodeLabel(node.callee);

    case 'ThisExpression':
      return 'this';

    default:
      return null;
  }
}

function extractPropertyName(node) {
  if (!node) {
    return null;
  }
  if (node.type === 'Identifier') {
    return node.name;
  }
  if (node.type === 'Literal') {
    return String(node.value);
  }
  return nodeLabel(node);
}

function normalizeTypeName(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value instanceof Date) {
    return 'string';
  }
  return typeof value;
}

function inferPrimitiveType(node) {
  if (!node) {
    return 'unknown';
  }

  switch (node.type) {
    case 'Literal':
      return normalizeTypeName(node.value);
    case 'ObjectExpression':
      return 'object';
    case 'ArrayExpression':
      return 'array';
    case 'TemplateLiteral':
      return 'string';
    case 'Identifier':
      return 'reference';
    case 'CallExpression': {
      const callee = nodeLabel(node.callee);
      if (callee === 'JSON.stringify') return 'json-string';
      if (callee === 'Number' || callee === 'parseInt' || callee === 'parseFloat') return 'number';
      if (callee === 'String') return 'string';
      if (callee === 'Boolean') return 'boolean';
      return 'computed';
    }
    case 'NewExpression': {
      const callee = nodeLabel(node.callee);
      if (callee === 'URLSearchParams') return 'query-string';
      if (callee === 'FormData') return 'form-data';
      return 'instance';
    }
    default:
      return 'computed';
  }
}

function collectVarBindings(ast) {
  const bindings = new Map();
  const formDataFields = new Map();

  if (!ast) {
    return { bindings, formDataFields };
  }

  estraverse.traverse(ast, {
    enter(node) {
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
        bindings.set(node.id.name, node.init ?? null);
        if (node.init?.type === 'NewExpression' && nodeLabel(node.init.callee) === 'FormData') {
          formDataFields.set(node.id.name, []);
        }
      }

      if (
        node.type === 'AssignmentExpression'
        && node.left?.type === 'Identifier'
      ) {
        bindings.set(node.left.name, node.right ?? null);
      }

      if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
        const objectName = nodeLabel(node.callee.object);
        const methodName = node.callee.property?.name;
        if (objectName && methodName === 'append' && formDataFields.has(objectName)) {
          const fieldName = node.arguments[0]?.type === 'Literal' ? String(node.arguments[0].value) : nodeLabel(node.arguments[0]);
          if (fieldName) {
            formDataFields.get(objectName).push(fieldName);
          }
        }
      }
    },
  });

  return { bindings, formDataFields };
}

function resolveNode(node, bindings, depth = 0) {
  if (!node || depth > 3) {
    return node;
  }

  if (node.type === 'Identifier' && bindings.has(node.name)) {
    return resolveNode(bindings.get(node.name), bindings, depth + 1);
  }

  return node;
}

function extractFieldsFromNode(node, bindings, formDataFields, depth = 0) {
  const resolved = resolveNode(node, bindings, depth);
  if (!resolved || depth > 4) {
    return [];
  }

  if (resolved.type === 'ObjectExpression') {
    return limit(resolved.properties.flatMap((property) => {
      if (property.type !== 'Property') {
        return [];
      }
      const name = extractPropertyName(property.key);
      if (!name) {
        return [];
      }
      const field = {
        name,
        type: inferPrimitiveType(property.value),
      };
      const nested = extractFieldsFromNode(property.value, bindings, formDataFields, depth + 1);
      if (nested.length > 0) {
        field.children = nested;
      }
      return [field];
    }), 30);
  }

  if (resolved.type === 'ArrayExpression') {
    const itemTypes = unique(resolved.elements.map((item) => inferPrimitiveType(item)));
    return [{
      name: '[items]',
      type: 'array',
      itemTypes,
    }];
  }

  if (resolved.type === 'CallExpression' && nodeLabel(resolved.callee) === 'JSON.stringify') {
    return extractFieldsFromNode(resolved.arguments[0], bindings, formDataFields, depth + 1);
  }

  if (resolved.type === 'NewExpression' && nodeLabel(resolved.callee) === 'URLSearchParams') {
    return extractFieldsFromNode(resolved.arguments[0], bindings, formDataFields, depth + 1);
  }

  if (resolved.type === 'Identifier' && formDataFields.has(resolved.name)) {
    return formDataFields.get(resolved.name).map((name) => ({
      name,
      type: 'string',
    }));
  }

  return [];
}

function extractConfigProperty(node, name) {
  if (!node || node.type !== 'ObjectExpression') {
    return null;
  }
  return node.properties.find((property) => property.type === 'Property' && extractPropertyName(property.key) === name)?.value ?? null;
}

function resolveEndpoint(node, bindings) {
  const resolved = resolveNode(node, bindings);
  if (!resolved) {
    return null;
  }

  if (resolved.type === 'Literal') {
    return typeof resolved.value === 'string' ? resolved.value : String(resolved.value);
  }

  if (resolved.type === 'TemplateLiteral') {
    return resolved.quasis.map((item) => item.value?.cooked ?? '').join('${...}');
  }

  return nodeLabel(resolved);
}

function collectQueryFieldsFromEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string' || !endpoint.includes('?')) {
    return [];
  }

  const query = endpoint.split('?')[1] ?? '';
  const names = query
    .split('&')
    .map((entry) => entry.split('=')[0])
    .map((entry) => entry.trim())
    .filter(Boolean);

  return unique(names).map((name) => ({ name, type: 'string' }));
}

function collectRequestShapes(source) {
  const ast = parseAst(source);
  const { bindings, formDataFields } = collectVarBindings(ast);
  const shapes = [];

  if (!ast) {
    return shapes;
  }

  estraverse.traverse(ast, {
    enter(node) {
      if (node.type !== 'CallExpression') {
        return;
      }

      const callee = nodeLabel(node.callee);
      if (!callee) {
        return;
      }

      if (callee === 'fetch') {
        const endpoint = resolveEndpoint(node.arguments[0], bindings);
        const config = resolveNode(node.arguments[1], bindings);
        const method = extractConfigProperty(config, 'method');
        const headers = extractConfigProperty(config, 'headers');
        const body = extractConfigProperty(config, 'body');
        const queryFields = collectQueryFieldsFromEndpoint(endpoint);
        const bodyFields = extractFieldsFromNode(body, bindings, formDataFields);
        const headerFields = extractFieldsFromNode(headers, bindings, formDataFields);

        shapes.push({
          transport: 'fetch',
          endpoint,
          method: getString(method?.value, 'GET').toUpperCase(),
          parameterLocations: [
            ...(queryFields.length > 0 ? [{ location: 'query', fields: queryFields }] : []),
            ...(bodyFields.length > 0 ? [{ location: 'body', fields: bodyFields }] : []),
            ...(headerFields.length > 0 ? [{ location: 'headers', fields: headerFields }] : []),
          ],
        });
        return;
      }

      const match = callee.match(/^(?<client>[A-Za-z_$][\w$.]*)\.(?<method>get|post|put|patch|delete)$/i);
      if (!match) {
        return;
      }

      const endpoint = resolveEndpoint(node.arguments[0], bindings);
      const method = match.groups.method.toUpperCase();
      const secondArg = resolveNode(node.arguments[1], bindings);
      const thirdArg = resolveNode(node.arguments[2], bindings);
      const config = method === 'GET' || method === 'DELETE' ? secondArg : thirdArg;
      const body = method === 'GET' || method === 'DELETE' ? null : secondArg;
      const params = extractConfigProperty(config, 'params');
      const headers = extractConfigProperty(config, 'headers');

      const queryFields = [
        ...collectQueryFieldsFromEndpoint(endpoint),
        ...extractFieldsFromNode(params, bindings, formDataFields),
      ];
      const bodyFields = extractFieldsFromNode(body, bindings, formDataFields);
      const headerFields = extractFieldsFromNode(headers, bindings, formDataFields);

      shapes.push({
        transport: match.groups.client,
        endpoint,
        method,
        parameterLocations: [
          ...(queryFields.length > 0 ? [{ location: 'query', fields: uniqueFields(queryFields) }] : []),
          ...(bodyFields.length > 0 ? [{ location: 'body', fields: uniqueFields(bodyFields) }] : []),
          ...(headerFields.length > 0 ? [{ location: 'headers', fields: uniqueFields(headerFields) }] : []),
        ],
      });
    },
  });

  return shapes;
}

function uniqueFields(fields) {
  const seen = new Set();
  const output = [];

  for (const field of fields ?? []) {
    const key = `${field.name}:${field.type}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(field);
  }

  return output;
}

function classifyObfuscationLevel(score) {
  if (score >= 24) {
    return 'high';
  }
  if (score >= 10) {
    return 'medium';
  }
  return 'low';
}

export function detectJsObfuscationSnippets(source, options = {}) {
  const analysis = analyzeJavaScript(source, options);
  const recognizedPatterns = unique([
    ...(analysis.signals.obfuscation.some((item) => /\beval\(/.test(item)) ? ['eval-loader'] : []),
    ...(analysis.signals.obfuscation.some((item) => /\bFunction\(/.test(item)) ? ['runtime-function-constructor'] : []),
    ...(analysis.signals.obfuscation.some((item) => /_0x[a-f0-9]+/i.test(item)) ? ['hex-identifier-renaming'] : []),
    ...(analysis.strings.base64.length > 0 ? ['embedded-base64-literals'] : []),
    ...(analysis.strings.hexEscapes.length > 0 ? ['hex-escape-runs'] : []),
    ...(analysis.strings.unicodeEscapes.length > 0 ? ['unicode-escape-runs'] : []),
  ]);

  return {
    kind: 'ai-js-obfuscation',
    target: options.target ?? null,
    meta: analysis.meta,
    confidence: classifyObfuscationLevel(analysis.score),
    score: analysis.score,
    metrics: analysis.metrics,
    recognizedPatterns,
    suspiciousIdentifiers: limit(
      unique([
        ...analysis.names.functions.filter((name) => /^_0x/i.test(name)),
        ...analysis.names.assignedFunctions.filter((name) => /^_0x/i.test(name)),
      ]),
      20,
    ),
    decodedPreview: {
      base64: limit(analysis.strings.base64, 5),
      hexEscapes: limit(analysis.strings.hexEscapes, 5),
      unicodeEscapes: limit(analysis.strings.unicodeEscapes, 5),
    },
    evidence: {
      obfuscationSignals: limit(analysis.signals.obfuscation, 20),
      antiDebugSignals: limit(analysis.signals.antiDebug, 20),
      transportSignals: limit(analysis.signals.transport, 20),
      endpoints: limit(analysis.endpoints, 20),
    },
  };
}

export function inferApiParameterStructure(source, options = {}) {
  const jsAnalysis = analyzeJavaScript(source, options);
  const requestShapes = collectRequestShapes(source)
    .filter((shape) => shape.endpoint || shape.parameterLocations.length > 0)
    .map((shape) => ({
      ...shape,
      parameterLocations: shape.parameterLocations.filter((entry) => entry.fields.length > 0),
    }));

  return {
    kind: 'ai-api-parameter-structure',
    target: options.target ?? null,
    endpoints: limit(jsAnalysis.endpoints, 40),
    requestShapes: limit(requestShapes, 20),
    signatureFunctions: limit(inferAllSignatureFunctions(source), 10),
    recommendedHooks: limit(jsAnalysis.recommendedHooks, 10),
  };
}

function tryParseJson(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return { ok: false, value: null };
    }
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch {
      return { ok: false, value: null };
    }
  }

  if (value && typeof value === 'object') {
    return { ok: true, value };
  }

  return { ok: false, value: null };
}

function normalizeResponseSamples(payload = {}) {
  const rawSamples = [
    ...(Array.isArray(payload.samples) ? payload.samples : []),
    ...(Array.isArray(payload.responseSamples) ? payload.responseSamples : []),
    ...(Array.isArray(payload.responseBodies) ? payload.responseBodies : []),
    ...(payload.sample !== undefined ? [payload.sample] : []),
    ...(payload.responseSample !== undefined ? [payload.responseSample] : []),
    ...(payload.responseBody !== undefined ? [payload.responseBody] : []),
    ...(payload.body !== undefined ? [payload.body] : []),
  ];

  return rawSamples
    .map((sample) => tryParseJson(sample))
    .filter((entry) => entry.ok)
    .map((entry) => entry.value);
}

function mergeTypeSets(a = [], b = []) {
  return unique([...a, ...b]).sort();
}

function mergeSchema(a, b) {
  if (!a) return b;
  if (!b) return a;

  const typeSet = mergeTypeSets(a.typeSet, b.typeSet);

  if (typeSet.includes('object')) {
    const propertyNames = unique([
      ...Object.keys(a.properties ?? {}),
      ...Object.keys(b.properties ?? {}),
    ]);
    const properties = {};
    for (const name of propertyNames) {
      properties[name] = mergeSchema(a.properties?.[name], b.properties?.[name]);
    }

    return {
      type: typeSet.length === 1 ? typeSet[0] : 'mixed',
      typeSet,
      properties,
      required: propertyNames.filter((name) => (a.required ?? []).includes(name) && (b.required ?? []).includes(name)),
      exampleCount: (a.exampleCount ?? 0) + (b.exampleCount ?? 0),
    };
  }

  if (typeSet.includes('array')) {
    return {
      type: typeSet.length === 1 ? typeSet[0] : 'mixed',
      typeSet,
      items: mergeSchema(a.items, b.items),
      exampleCount: (a.exampleCount ?? 0) + (b.exampleCount ?? 0),
    };
  }

  return {
    type: typeSet.length === 1 ? typeSet[0] : 'mixed',
    typeSet,
    exampleCount: (a.exampleCount ?? 0) + (b.exampleCount ?? 0),
    examples: limit(unique([...(a.examples ?? []), ...(b.examples ?? [])]), 3),
  };
}

function schemaFromValue(value, depth = 0) {
  if (depth > 6) {
    return {
      type: 'unknown',
      typeSet: ['unknown'],
      exampleCount: 1,
    };
  }

  if (Array.isArray(value)) {
    const itemSchema = value.reduce((acc, item) => mergeSchema(acc, schemaFromValue(item, depth + 1)), null);
    return {
      type: 'array',
      typeSet: ['array'],
      items: itemSchema,
      exampleCount: 1,
    };
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return {
      type: 'object',
      typeSet: ['object'],
      properties: Object.fromEntries(entries.map(([key, entry]) => [key, schemaFromValue(entry, depth + 1)])),
      required: entries.map(([key]) => key),
      exampleCount: 1,
    };
  }

  const type = normalizeTypeName(value);
  return {
    type,
    typeSet: [type],
    exampleCount: 1,
    examples: value === null || value === undefined ? [] : [value],
  };
}

function summarizeSchema(schema, depth = 0) {
  if (!schema || depth > 6) {
    return null;
  }

  const summary = {
    type: schema.type,
    typeSet: schema.typeSet,
    exampleCount: schema.exampleCount,
  };

  if (schema.required?.length) {
    summary.required = schema.required;
  }

  if (schema.examples?.length) {
    summary.examples = schema.examples;
  }

  if (schema.properties) {
    summary.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, value]) => [key, summarizeSchema(value, depth + 1)]),
    );
  }

  if (schema.items) {
    summary.items = summarizeSchema(schema.items, depth + 1);
  }

  return summary;
}

export function inferResponseSchema(payload = {}) {
  const samples = normalizeResponseSamples(payload);
  const schema = samples.reduce((acc, sample) => mergeSchema(acc, schemaFromValue(sample)), null);

  return {
    kind: 'ai-response-schema',
    sampleCount: samples.length,
    rootType: schema?.type ?? 'unknown',
    schema: summarizeSchema(schema),
    examplesPreview: limit(samples, 2),
  };
}

function findCaptchaSignals(body = '', headers = {}) {
  const loweredBody = body.toLowerCase();
  const loweredHeaders = lowerHeaders(headers);
  const signals = [];
  let vendor = null;

  const patterns = [
    { vendor: 'recaptcha', pattern: /(g-recaptcha|recaptcha\/api\.js|google recaptcha|i'm not a robot)/i },
    { vendor: 'hcaptcha', pattern: /(hcaptcha|h-captcha-response)/i },
    { vendor: 'turnstile', pattern: /(cf-turnstile|turnstile\/v0|challenges.cloudflare.com)/i },
    { vendor: 'geetest', pattern: /(geetest|gt_captcha_obj)/i },
    { vendor: 'slider', pattern: /(slider captcha|drag the slider|slide to verify)/i },
  ];

  for (const entry of patterns) {
    if (entry.pattern.test(loweredBody)) {
      vendor = vendor ?? entry.vendor;
      signals.push(entry.vendor);
    }
  }

  if (loweredHeaders['x-captcha-provider']) {
    vendor = vendor ?? loweredHeaders['x-captcha-provider'];
    signals.push(`header:${loweredHeaders['x-captcha-provider']}`);
  }

  return {
    detected: signals.length > 0,
    vendor: vendor ?? (signals.length > 0 ? 'unknown' : null),
    signals: unique(signals),
  };
}

function findAntiCrawlSignals({ status = 200, body = '', headers = {} } = {}) {
  const loweredBody = body.toLowerCase();
  const loweredHeaders = lowerHeaders(headers);
  const categories = [];
  const signals = [];

  if ([403, 429, 503].includes(Number(status))) {
    categories.push('blocking-status');
    signals.push(`status:${status}`);
  }

  const antiBotPatterns = [
    { category: 'rate-limit', pattern: /(too many requests|rate limit exceeded)/i },
    { category: 'javascript-challenge', pattern: /(enable javascript|checking your browser|challenge-platform)/i },
    { category: 'bot-wall', pattern: /(verify you are human|access denied|bot detected|unusual traffic)/i },
    { category: 'login-wall', pattern: /(sign in to continue|登录后继续|请先登录)/i },
  ];

  for (const entry of antiBotPatterns) {
    if (entry.pattern.test(loweredBody)) {
      categories.push(entry.category);
      signals.push(entry.category);
    }
  }

  if (loweredHeaders['retry-after']) {
    categories.push('rate-limit');
    signals.push('header:retry-after');
  }

  return {
    detected: categories.length > 0,
    categories: unique(categories),
    signals: unique(signals),
    confidence: categories.length >= 3 ? 'high' : categories.length >= 1 ? 'medium' : 'low',
  };
}

export function classifyProtectionSurface(payload = {}) {
  const body = normalizeBody(payload);
  const headers = getObject(payload.headers);
  const status = Number(payload.status ?? 200);
  const waf = detectWaf({ status, headers, body });
  const captcha = findCaptchaSignals(body, headers);
  const antiCrawl = findAntiCrawlSignals({ status, body, headers });

  return {
    kind: 'ai-protection-classification',
    status,
    waf: {
      detected: waf.waf !== 'unknown',
      type: waf.waf,
      signals: waf.signals,
    },
    captcha,
    antiCrawl,
    classification: waf.waf !== 'unknown'
      ? 'waf'
      : captcha.detected
        ? 'captcha'
        : antiCrawl.detected
          ? 'anti-crawl'
          : 'normal',
  };
}

/**
 * Perform comprehensive AI-powered surface analysis combining obfuscation detection,
 * API parameter inference, response schema analysis, and protection classification.
 *
 * @param {Record<string, unknown>} [payload={}]
 * @returns {Promise<AiSurfaceAnalysisResult>}
 */
export async function analyzeAISurface(payload = {}) {
  // Prefer explicit code/source; if only HTML is provided, extract inline <script> blocks.
  const rawSource = getString(payload.source ?? payload.code ?? payload.html ?? payload.body, '');
  const isHtml = typeof payload.html === 'string' && !payload.code && !payload.source;
  const source = isHtml ? extractInlineScriptCode(rawSource) : rawSource;
  const headers = getObject(payload.headers);
  const status = Number(payload.status ?? 200);
  const body = normalizeBody(payload);

  // Run individual analysis functions
  const obfuscation = source
    ? detectJsObfuscationSnippets(source, { maxLiterals: 60, maxIdentifiers: 40 })
    : { detected: false, confidence: 'none', recognizedPatterns: [], suspiciousIdentifiers: [], evidence: {} };

  const apiParameters = source
    ? inferApiParameterStructure(source, { maxEndpoints: 15 })
    : { endpoints: [], requestShapes: [], signatureFunctions: [] };

  const responseSchema = inferResponseSchema(payload);

  const protection = classifyProtectionSurface({ status, headers, body });

  // Build AI prompts if provider is available
  const report = { obfuscation, apiParameters, responseSchema, protection };
  const prompts = buildAiPrompts(report);

  // Attempt to run AI provider if configured
  const aiConfig = payload.ai ?? { enabled: false };
  const aiResult = await maybeRunAiProvider(aiConfig, prompts);

  return {
    kind: 'ai-surface-analysis',
    target: payload.target ?? null,
    obfuscation,
    apiParameters,
    responseSchema,
    protection,
    ai: aiResult,
    prompts: aiResult.executed ? null : prompts,
  };
}

function buildAiPrompts(report) {
  const compactEvidence = {
    obfuscation: {
      confidence: report.obfuscation.confidence,
      recognizedPatterns: report.obfuscation.recognizedPatterns,
      suspiciousIdentifiers: report.obfuscation.suspiciousIdentifiers,
      endpoints: report.obfuscation.evidence.endpoints,
    },
    apiParameters: {
      endpoints: report.apiParameters.endpoints,
      requestShapes: report.apiParameters.requestShapes,
      signatureFunctions: report.apiParameters.signatureFunctions,
    },
    responseSchema: {
      sampleCount: report.responseSchema.sampleCount,
      rootType: report.responseSchema.rootType,
      schema: report.responseSchema.schema,
    },
    protection: report.protection,
  };

  const system = [
    'You are a defensive analysis assistant for a web crawler framework.',
    'Summarize code and traffic evidence without suggesting exploitation, bypass, credential harvesting, or evasion.',
    'Focus on: obfuscation recognition, request parameter structure, response schema, and protection-page classification.',
    'If uncertainty remains, say so explicitly.',
  ].join(' ');

  const user = [
    'Analyze the following evidence and return a compact structured summary.',
    'Include: overall judgment, likely request/response model, notable obfuscation markers, and protection classification.',
    'Do not provide attack, bypass, exploit, or decryption instructions.',
    JSON.stringify(compactEvidence, null, 2),
  ].join('\n\n');

  return {
    system,
    user,
    format: 'json-or-plain-summary',
    evidence: compactEvidence,
  };
}

async function maybeRunAiProvider(aiConfig, promptPayload) {
  const provider = aiConfig?.provider ?? aiConfig?.client ?? aiConfig?.executor ?? null;
  if (!provider) {
    return {
      enabled: Boolean(aiConfig?.enabled),
      executed: false,
      summary: null,
      error: null,
      prompt: promptPayload,
      advisory: aiConfig?.enabled
        ? 'No ai provider was supplied. Use the returned prompt payload with your own LLM client.'
        : null,
    };
  }

  try {
    let response;
    if (typeof provider === 'function') {
      response = await provider(promptPayload);
    } else if (typeof provider.analyze === 'function') {
      response = await provider.analyze(promptPayload);
    } else if (typeof provider.generate === 'function') {
      response = await provider.generate(promptPayload);
    } else if (typeof provider.complete === 'function') {
      response = await provider.complete(promptPayload);
    } else {
      throw new Error('Unsupported ai provider interface');
    }

    return {
      enabled: true,
      executed: true,
      summary: response,
      error: null,
      prompt: promptPayload,
      advisory: null,
    };
  } catch (error) {
    return {
      enabled: true,
      executed: true,
      summary: null,
      error: error?.message ?? String(error),
      prompt: promptPayload,
      advisory: null,
    };
  }
}

export const aiAnalysis = {
  analyzeAISurface,
  detectJsObfuscationSnippets,
  inferApiParameterStructure,
  inferResponseSchema,
  classifyProtectionSurface,
  
  /**
   * 通用 AI 推理接口
   * @param {string} prompt 提示词
   * @param {object} options 配置 (model, temperature, jsonMode)
   */
  async reason(prompt, options = {}) {
    const aiConfig = options.ai || { enabled: true };
    const promptPayload = {
      system: options.system || 'You are a helpful web automation assistant.',
      user: prompt,
      format: options.jsonMode ? 'json' : 'text'
    };
    
    const result = await maybeRunAiProvider(aiConfig, promptPayload);
    if (result.error) throw new Error(result.error);
    
    if (options.jsonMode && typeof result.summary === 'string') {
      try {
        // 尝试从 Markdown 代码块中提取 JSON
        const jsonMatch = result.summary.match(/```json\n([\s\S]*?)\n```/) || [null, result.summary];
        return JSON.parse(jsonMatch[1]);
      } catch (e) {
        return result.summary;
      }
    }
    
    return result.summary;
  }
};
