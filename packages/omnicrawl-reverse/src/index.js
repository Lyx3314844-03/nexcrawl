/**
 * omnicrawl-reverse — Reverse Engineering Plugin for OmniCrawl
 *
 * This package provides standalone reverse engineering capabilities
 * and integrates with OmniCrawl via `.useStealth()`.
 *
 * When used standalone, import individual modules directly:
 *   import { analyzeJavaScript } from 'omnicrawl-reverse';
 *   import { solveCaptcha } from 'omnicrawl-reverse/captcha-solver';
 *
 * When used with OmniCrawl, the reverse context is automatically
 * available in route handlers via `ctx.reverse`.
 */

// ─── Standalone utilities (no omnicrawl dependency) ────────

// Re-export from omnicrawl if available; otherwise provide standalone stubs
// This pattern allows the package to work both standalone and as a plugin

// Lazy omnicrawl peer integration — avoids top-level await
let _omnicrawlReverse = null;
let _omnicrawlChecked = false;

function _getOmnicrawlReverse() {
  if (_omnicrawlChecked) return _omnicrawlReverse;
  _omnicrawlChecked = true;
  try {
    // Dynamic import returns a promise; synchronously we can't await it,
    // so we use a flag to indicate the peer is not available synchronously.
    // Consumers can use the `_standalone` flag to check.
    _omnicrawlReverse = null; // Will remain null in synchronous context
  } catch {
    _omnicrawlReverse = null;
  }
  return _omnicrawlReverse;
}

/**
 * Whether the plugin is running in standalone mode (without omnicrawl peer).
 * Check this flag to know if full reverse engine is available.
 */
export const _standalone = true; // Always true in standalone package


// ─── Standalone reverse analysis utilities ────────────────

/**
 * Analyze HTML for reverse engineering opportunities.
 * Standalone implementation that works without omnicrawl.
 */
export async function analyzeHtmlForReverse(html, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)analyzeHtmlForReverse(html, options);

  // Standalone fallback: basic script/form extraction
  const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const formMatches = html.match(/<form[^>]*>[\s\S]*?<\/form>/gi) ?? [];
  return {
    scripts: scriptMatches.length,
    forms: formMatches.length,
    hasObfuscation: /\b(eval|Function|atob|unescape)\b/.test(html),
    hasAntiBot: /cloudflare|recaptcha|hcaptcha|turnstile/i.test(html),
  };
}

/**
 * Analyze JavaScript source for reverse engineering insights.
 */
export async function analyzeJavaScript(source, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)analyzeJavaScript(source, options);

  // Standalone fallback: basic pattern analysis
  return {
    size: source.length,
    hasEval: /\beval\s*\(/.test(source),
    hasFunction: /new\s+Function\s*\(/.test(source),
    hasWebpack: /\b__webpack_require__\b|\bwebpackChunk\b/.test(source),
    hasProtobuf: /\.proto\b|protobuf|\.decode\b/.test(source),
    apiEndpoints: [...source.matchAll(/['"`](https?:\/\/[^\s'"`]+\/api\/[^\s'"`]+)['"`]/g)].map(m => m[1]),
    fetchCalls: [...source.matchAll(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g)].map(m => m[1]),
  };
}

/**
 * Execute a reverse engineering snippet in sandboxed context.
 */
export async function executeReverseSnippet(code, context = {}) {
  // Standalone implementation (no omnicrawl peer dependency)executeReverseSnippet(code, context);
  throw new Error('executeReverseSnippet requires omnicrawl peer dependency for sandboxed execution');
}

/**
 * Invoke a named function from deobfuscated code.
 */
export async function invokeNamedFunction(name, args = [], context = {}) {
  // Standalone implementation (no omnicrawl peer dependency)invokeNamedFunction(name, args, context);
  throw new Error('invokeNamedFunction requires omnicrawl peer dependency for sandboxed execution');
}

// ─── Reverse capabilities ─────────────────────────────────

export async function getReverseCapabilitySnapshot() {
  // Standalone implementation (no omnicrawl peer dependency)getReverseCapabilitySnapshot();
  return { standalone: true, capabilities: ['analyzeHtmlForReverse', 'analyzeJavaScript'] };
}

export async function runReverseOperation(operation, params) {
  // Standalone implementation (no omnicrawl peer dependency)runReverseOperation(operation, params);
  throw new Error(`runReverseOperation('${operation}') requires omnicrawl peer dependency`);
}

// ─── CAPTCHA solving ──────────────────────────────────────

export async function solveCaptcha(type, page, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)solveCaptcha(type, page, options);
  throw new Error('solveCaptcha requires omnicrawl peer dependency (needs browser context)');
}

export function detectCaptcha(html) {
  // Standalone implementation (no omnicrawl peer dependency)detectCaptcha(html);
  // Standalone detection
  const types = [];
  if (/recaptcha/i.test(html)) types.push('recaptcha');
  if (/hcaptcha/i.test(html)) types.push('hcaptcha');
  if (/turnstile/i.test(html)) types.push('turnstile');
  if (/grecaptcha/i.test(html)) types.push('recaptcha-v3');
  return { detected: types.length > 0, types };
}

export async function autoSolveCaptcha(page, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)autoSolveCaptcha(page, options);
  throw new Error('autoSolveCaptcha requires omnicrawl peer dependency');
}

export async function injectCaptchaToken(page, token, selector) {
  // Standalone implementation (no omnicrawl peer dependency)injectCaptchaToken(page, token, selector);
  throw new Error('injectCaptchaToken requires omnicrawl peer dependency');
}

export async function getCaptchaBalance() {
  // Standalone implementation (no omnicrawl peer dependency)getCaptchaBalance();
  return { balance: 0, provider: 'none' };
}

// ─── Cloudflare bypass ────────────────────────────────────

export function detectCloudflareChallenge(html) {
  // Standalone implementation (no omnicrawl peer dependency)detectCloudflareChallenge(html);
  // Standalone detection
  return {
    isCloudflare: /cloudflare/i.test(html) || /cf-browser-verification/i.test(html),
    challengeType: /jschl/.test(html) ? 'js' : /turnstile/.test(html) ? 'turnstile' : null,
  };
}

export async function solveJsChallenge(page, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)solveJsChallenge(page, options);
  throw new Error('solveJsChallenge requires omnicrawl peer dependency');
}

export async function waitForClearanceCookie(page, timeout = 30000) {
  // Standalone implementation (no omnicrawl peer dependency)waitForClearanceCookie(page, timeout);
  throw new Error('waitForClearanceCookie requires omnicrawl peer dependency');
}

export async function handleCloudflareChallenge(page, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)handleCloudflareChallenge(page, options);
  throw new Error('handleCloudflareChallenge requires omnicrawl peer dependency');
}

export function buildCloudflareStealthHeaders() {
  // Standalone implementation (no omnicrawl peer dependency)buildCloudflareStealthHeaders();
  // Standalone: return basic stealth headers
  return {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
  };
}

// ─── Behavior simulation ──────────────────────────────────

export function generateMousePath(start, end, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)generateMousePath(start, end, options);
  // Standalone: simple linear path
  const steps = options.steps ?? 20;
  const path = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    path.push({ x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t, delay: 8 + Math.random() * 12 });
  }
  return path;
}

export function generateTypingEvents(text, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)generateTypingEvents(text, options);
  // Standalone: simple typing with random delays
  return [...text].map(char => ({ char, delay: 50 + Math.random() * 100 }));
}

export function generateScrollEvents(distance, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)generateScrollEvents(distance, options);
  // Standalone: simple scroll events
  const steps = Math.ceil(Math.abs(distance) / 100);
  return Array.from({ length: steps }, (_, i) => ({ deltaY: distance / steps, delay: 100 + Math.random() * 50 }));
}

export function generateInteractionSequence(actions = []) {
  // Standalone implementation (no omnicrawl peer dependency)generateInteractionSequence(actions);
  return actions.map(action => ({ ...action, timestamp: Date.now() + Math.random() * 1000 }));
}

export async function executeInteractionSequence(page, sequence) {
  // Standalone implementation (no omnicrawl peer dependency)executeInteractionSequence(page, sequence);
  throw new Error('executeInteractionSequence requires omnicrawl peer dependency');
}

export function injectBehaviorSimulation(page) {
  // Standalone implementation (no omnicrawl peer dependency)injectBehaviorSimulation(page);
  throw new Error('injectBehaviorSimulation requires omnicrawl peer dependency');
}

export function analyzeBehaviorPattern(events) {
  // Standalone implementation (no omnicrawl peer dependency)analyzeBehaviorPattern(events);
  // Standalone: basic pattern summary
  return { totalEvents: events.length, types: [...new Set(events.map(e => e.type))] };
}

// ─── Signature & RPC ──────────────────────────────────────

export async function locateSignatureFunctions(source, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)locateSignatureFunctions(source, options);
  // Standalone: basic regex-based signature detection
  const patterns = [/sign\s*[=:]\s*function/i, /getSignature/i, /generateToken/i, /computeHash/i, /createHmac/i];
  const results = [];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) results.push({ name: match[0], confidence: 0.6 });
  }
  return results;
}

export async function extractFunctionWithDependencies(source, functionName) {
  // Standalone implementation (no omnicrawl peer dependency)extractFunctionWithDependencies(source, functionName);
  throw new Error('extractFunctionWithDependencies requires omnicrawl peer dependency');
}

export async function generateRPCWrapper(functionCode, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)generateRPCWrapper(functionCode, options);
  throw new Error('generateRPCWrapper requires omnicrawl peer dependency');
}

export async function autoSetupSignatureRPC(source, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)autoSetupSignatureRPC(source, options);
  throw new Error('autoSetupSignatureRPC requires omnicrawl peer dependency');
}

export async function callSignatureRPC(rpcServer, functionName, params) {
  // Standalone implementation (no omnicrawl peer dependency)callSignatureRPC(rpcServer, functionName, params);
  throw new Error('callSignatureRPC requires omnicrawl peer dependency');
}

// ─── App WebView ──────────────────────────────────────────

export function getAppWebViewProfile(appName) {
  // Standalone implementation (no omnicrawl peer dependency)getAppWebViewProfile(appName);
  return null;
}

export function getAvailableWebViewProfiles() {
  // Standalone implementation (no omnicrawl peer dependency)getAvailableWebViewProfiles();
  return [];
}

export function buildJSBridgeInjection(profile) {
  // Standalone implementation (no omnicrawl peer dependency)buildJSBridgeInjection(profile);
  throw new Error('buildJSBridgeInjection requires omnicrawl peer dependency');
}

export async function injectAppWebView(page, profile) {
  // Standalone implementation (no omnicrawl peer dependency)injectAppWebView(page, profile);
  throw new Error('injectAppWebView requires omnicrawl peer dependency');
}

export function detectAppWebView(html) {
  // Standalone implementation (no omnicrawl peer dependency)detectAppWebView(html);
  return { detected: false };
}

export function createAppScrapeConfig(appName, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)createAppScrapeConfig(appName, options);
  throw new Error('createAppScrapeConfig requires omnicrawl peer dependency');
}

// ─── Protocol analysis ────────────────────────────────────

export async function analyzeProtobufPayload(buffer, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)analyzeProtobufPayload(buffer, options);
  throw new Error('analyzeProtobufPayload requires omnicrawl peer dependency');
}

export async function analyzeGrpcPayload(buffer, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)analyzeGrpcPayload(buffer, options);
  throw new Error('analyzeGrpcPayload requires omnicrawl peer dependency');
}

export async function loadProtoSchema(pathOrUrl) {
  // Standalone implementation (no omnicrawl peer dependency)loadProtoSchema(pathOrUrl);
  throw new Error('loadProtoSchema requires omnicrawl peer dependency');
}

export async function decodeProtobufMessage(buffer, schema, messageType) {
  // Standalone implementation (no omnicrawl peer dependency)decodeProtobufMessage(buffer, schema, messageType);
  throw new Error('decodeProtobufMessage requires omnicrawl peer dependency');
}

export function normalizeBinaryInput(input) {
  // Standalone implementation (no omnicrawl peer dependency)normalizeBinaryInput(input);
  if (typeof input === 'string') return Buffer.from(input, 'base64');
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(input);
}

// ─── Native integration ──────────────────────────────────

export function buildNativeCapturePlan(url, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)buildNativeCapturePlan(url, options);
  throw new Error('buildNativeCapturePlan requires omnicrawl peer dependency');
}

export function getNativeToolStatus() {
  // Standalone implementation (no omnicrawl peer dependency)getNativeToolStatus();
  return { available: false, tools: {} };
}

// ─── Node runtime analysis ────────────────────────────────

export async function analyzeNodeProfile(options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)analyzeNodeProfile(options);
  throw new Error('analyzeNodeProfile requires omnicrawl peer dependency');
}

export function deobfuscateNodeLiterals(source, options = {}) {
  // Standalone implementation (no omnicrawl peer dependency)deobfuscateNodeLiterals(source, options);
  // Standalone: basic hex/unicode string deobfuscation
  return source.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
