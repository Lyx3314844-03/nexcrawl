import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReverseEngine } from "../src/reverse/reverse-engine.js";
import { ReversePlugin } from "../src/plugins/reverse-plugin.js";
import { OmniCrawler } from "../src/api/omnicrawler.js";
import { CrawlContextImpl } from "../src/api/crawl-context.js";
import { buildReverseEngineConfigFromWorkflow } from "../src/runtime/reverse-workflow-runtime.js";

test("ReverseEngine defaults all to disabled", () => {
  const e = new ReverseEngine();
  assert.equal(e.enabled, false);
  assert.equal(e.requiresBrowser, false);
  assert.equal(e.stealth, false);
  assert.equal(e.cloudflare, false);
  assert.equal(e.captcha, null);
  assert.equal(e.behaviorSim, false);
  assert.equal(e.appWebView, null);
  assert.equal(e.reverseAnalysis, false);
  assert.equal(e.tlsProfile, null);
});

test("ReverseEngine enabled when any capability configured", () => {
  assert.equal(new ReverseEngine({ stealth: true }).enabled, true);
  assert.equal(new ReverseEngine({ cloudflare: true }).enabled, true);
  assert.equal(new ReverseEngine({ captcha: { provider: "capsolver", apiKey: "t" } }).enabled, true);
  assert.equal(new ReverseEngine({ behaviorSim: true }).enabled, true);
  assert.equal(new ReverseEngine({ appWebView: "wechat" }).enabled, true);
  assert.equal(new ReverseEngine({ reverseAnalysis: true }).enabled, true);
  assert.equal(new ReverseEngine({ tlsProfile: "chrome_120" }).enabled, true);
});

test("ReverseEngine requiresBrowser for browser-level only", () => {
  assert.equal(new ReverseEngine({ stealth: true }).requiresBrowser, true);
  assert.equal(new ReverseEngine({ cloudflare: true }).requiresBrowser, true);
  assert.equal(new ReverseEngine({ behaviorSim: true }).requiresBrowser, true);
  assert.equal(new ReverseEngine({ appWebView: "wechat" }).requiresBrowser, true);
  assert.equal(new ReverseEngine({ reverseAnalysis: true }).requiresBrowser, false);
  assert.equal(new ReverseEngine({ tlsProfile: "chrome_120" }).requiresBrowser, false);
});

test("ReverseEngine analysis methods return safe fallback", async () => {
  const e = new ReverseEngine();
  assert.equal((await e.analyzeJS("x")).success, false);
  assert.equal((await e.analyzeCrypto("x")).success, false);
  assert.equal((await e.analyzeWebpack("x")).success, false);
  assert.equal((await e.locateSignature("x")).success, false);
  assert.equal((await e.analyzeAISurface({ code: "x" })).success, false);
});

test("ReverseEngine can run AI surface analysis when reverse analysis is enabled", async () => {
  const e = new ReverseEngine({ reverseAnalysis: true });
  const result = await e.analyzeAISurface({
    code: 'const body = { token: "demo" }; fetch("/api/demo", { method: "POST", body: JSON.stringify(body) });',
    responseBody: '{"ok":true}',
  });

  assert.equal(result.kind, 'ai-surface-analysis');
  assert.ok(result.apiParameters.endpoints.includes('/api/demo'));
  assert.equal(result.responseSchema.rootType, 'object');
});

test("ReverseEngine resolveChallenge uses current Cloudflare and CAPTCHA solver contracts", async () => {
  const cloudflareEngine = new ReverseEngine({ cloudflare: { maxWaitMs: 1000 } });
  cloudflareEngine._loadCloudflareSolver = async () => ({
    handleCloudflareChallenge: async () => ({
      success: true,
      method: 'turnstile-via-captcha',
      solution: { solution: 'cf-token' },
    }),
  });
  const cloudflareResult = await cloudflareEngine.resolveChallenge({}, {});
  assert.equal(cloudflareResult.solved, true);
  assert.equal(cloudflareResult.type, 'turnstile');
  assert.equal(cloudflareResult.token, 'cf-token');

  const captchaEngine = new ReverseEngine({ captcha: { provider: 'capsolver', apiKey: 'CAP-1' } });
  captchaEngine._loadCaptchaSolver = async () => ({
    detectCaptcha: async () => ({ present: true, type: 'turnstile', siteKey: 'site-key' }),
    autoSolveCaptcha: async () => ({
      detected: { type: 'turnstile', siteKey: 'site-key' },
      solved: { solution: 'captcha-token' },
    }),
  });
  const captchaResult = await captchaEngine.resolveChallenge({
    url() {
      return 'https://example.com';
    },
  }, {});
  assert.equal(captchaResult.solved, true);
  assert.equal(captchaResult.type, 'turnstile');
  assert.equal(captchaResult.token, 'captcha-token');
});

test("ReversePlugin throws if engine not enabled", () => {
  assert.throws(() => new ReversePlugin(new ReverseEngine()), /enabled/);
});

test("ReversePlugin creates plugin with hooks", () => {
  const e = new ReverseEngine({ stealth: true });
  const p = new ReversePlugin(e);
  const h = p.createPlugin();
  assert.equal(h.name, "omnicrawler-reverse");
  assert.equal(typeof h.beforeRequest, "function");
  assert.equal(typeof h.afterResponse, "function");
  assert.equal(typeof h.afterExtract, "function");
});

test("ReversePlugin beforeRequest injects TLS profile", async () => {
  const e = new ReverseEngine({ tlsProfile: "chrome_120" });
  const h = new ReversePlugin(e).createPlugin();
  const payload = { request: { url: "https://example.com" } };
  await h.beforeRequest(payload);
  assert.equal(payload.request.tlsProfile, "chrome_120");
});

test("ReversePlugin beforeRequest injects H2 profile", async () => {
  const e = new ReverseEngine({ h2Profile: { headerOrder: ["host"] } });
  const h = new ReversePlugin(e).createPlugin();
  const payload = { request: { url: "https://example.com" } };
  await h.beforeRequest(payload);
  assert.deepEqual(payload.request.h2Profile, { headerOrder: ["host"] });
});

test("ReversePlugin afterResponse skips non-challenge status", async () => {
  const e = new ReverseEngine({ cloudflare: true });
  const h = new ReversePlugin(e).createPlugin();
  const payload = { response: { status: 200 }, request: { url: "https://example.com" } };
  await h.afterResponse(payload);
  assert.equal(payload.response._challengeSolved, undefined);
});

test("ReversePlugin reset clears counters", () => {
  const e = new ReverseEngine({ cloudflare: true });
  const p = new ReversePlugin(e);
  p._challengeRetryCount.set("x", 3);
  p.reset();
  assert.equal(p._challengeRetryCount.size, 0);
});

test("OmniCrawler useStealth fluent", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.equal(c.useStealth(), c);
  assert.equal(c._reverseConfig.stealth, true);
});

test("OmniCrawler useStealth with options", () => {
  const c = new OmniCrawler({ name: "test" });
  c.useStealth({ locale: "en-US" });
  assert.deepEqual(c._reverseConfig.stealth, { locale: "en-US" });
});

test("OmniCrawler useCloudflareSolver fluent", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.equal(c.useCloudflareSolver(), c);
  assert.equal(c._reverseConfig.cloudflare, true);
});

test("OmniCrawler useCaptchaSolver validates input", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.throws(() => c.useCaptchaSolver(), /provider and apiKey/);
  c.useCaptchaSolver("capsolver", "CAP-xxx");
  assert.equal(c._reverseConfig.captcha.provider, "capsolver");
});

test("OmniCrawler useBehaviorSimulation fluent", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.equal(c.useBehaviorSimulation(), c);
});

test("OmniCrawler useAppWebView validates type", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.throws(() => c.useAppWebView("invalid"), /Invalid appWebView/);
  assert.equal(c.useAppWebView("wechat"), c);
  assert.equal(c._reverseConfig.appWebView, "wechat");
});

test("OmniCrawler useReverseAnalysis fluent", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.equal(c.useReverseAnalysis(), c);
});

test("OmniCrawler useTlsProfile validates", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.throws(() => c.useTlsProfile(), /profile name/);
  c.useTlsProfile("chrome_120");
  assert.equal(c._reverseConfig.tlsProfile, "chrome_120");
});

test("OmniCrawler useH2Profile validates", () => {
  const c = new OmniCrawler({ name: "test" });
  assert.throws(() => c.useH2Profile(), /profile config/);
});

test("OmniCrawler useReverse merges config", () => {
  const c = new OmniCrawler({ name: "test" });
  c.useStealth().useCloudflareSolver().useBehaviorSimulation();
  assert.equal(c._reverseConfig.stealth, true);
  assert.equal(c._reverseConfig.cloudflare, true);
  assert.equal(c._reverseConfig.behaviorSim, true);
});

test("OmniCrawler projects identity signer and reverse runtime config into workflow", () => {
  const c = new OmniCrawler({ name: "test" });
  c.addSeedUrls("https://example.com");
  c.setIdentity({
    enabled: true,
    userAgent: "UnitTestUA/1.0",
  });
  c.setSigner({
    enabled: true,
    inject: {
      enabled: true,
      location: "header",
      name: "x-signature",
    },
  });
  c.setReverseRuntime({
    enabled: true,
    autoReverseAnalysis: true,
  });
  c.useTlsProfile("chrome_120");

  const workflow = c._buildWorkflow();
  assert.equal(workflow.identity.userAgent, "UnitTestUA/1.0");
  assert.equal(workflow.identity.tlsProfile, "chrome_120");
  assert.equal(workflow.reverse.autoReverseAnalysis, true);
  assert.equal(workflow.signer.enabled, true);
  assert.equal(workflow.signer.inject.name, "x-signature");
});

test("OmniCrawler projects advanced reverse solver settings into workflow", () => {
  const c = new OmniCrawler({ name: "test" });
  c.addSeedUrls("https://example.com");
  c.useCloudflareSolver({ timeout: 4321 });
  c.useCaptchaSolver("capsolver", "CAP-123", { maxWaitMs: 5000 });
  c.useBehaviorSimulation({ scrolling: true });

  const workflow = c._buildWorkflow();
  const runtimeConfig = buildReverseEngineConfigFromWorkflow(workflow);

  assert.deepEqual(workflow.reverse.cloudflare, { timeout: 4321 });
  assert.equal(workflow.reverse.captcha.provider, "capsolver");
  assert.equal(workflow.reverse.captcha.apiKey, "CAP-123");
  assert.deepEqual(workflow.reverse.behaviorSimulation, { scrolling: true });
  assert.deepEqual(runtimeConfig.cloudflare, { timeout: 4321 });
  assert.equal(runtimeConfig.captcha.apiKey, "CAP-123");
  assert.deepEqual(runtimeConfig.behaviorSim, { scrolling: true });
});

test("OmniCrawler persists advanced reverse settings into workflow snapshots for replay", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><head><title>Reverse Snapshot</title></head><body>ok</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-reverse-snapshot-"));
  const url = `http://127.0.0.1:${server.address().port}/snapshot`;

  try {
    const crawler = new OmniCrawler({ name: "reverse-snapshot", projectRoot: root })
      .addSeedUrls(url)
      .setMode("http")
      .useStealth({ locale: "en-US" })
      .useCloudflareSolver({ timeout: 4321 })
      .useCaptchaSolver("capsolver", "CAP-123", { maxWaitMs: 5000 })
      .useBehaviorSimulation({ scrolling: true })
      .useReverseAnalysis();

    const summary = await crawler.run();
    const persisted = JSON.parse(await readFile(join(summary.runDir, "workflow.json"), "utf8"));

    assert.equal(persisted.workflow.identity.locale, "en-US");
    assert.deepEqual(persisted.workflow.reverse.cloudflare, { timeout: 4321 });
    assert.equal(persisted.workflow.reverse.captcha.provider, "capsolver");
    assert.equal(persisted.workflow.reverse.captcha.apiKey, "CAP-123");
    assert.deepEqual(persisted.workflow.reverse.behaviorSimulation, { scrolling: true });
    assert.equal(persisted.workflow.reverse.autoReverseAnalysis, true);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("OmniCrawler projects programmatic reverse helpers into workflow and runtime config", () => {
  const c = new OmniCrawler({ name: "reverse-projection" });
  c.addSeedUrls("https://example.com");
  c.useCloudflareSolver({ maxWaitMs: 1500 });
  c.useCaptchaSolver("capsolver", "CAP-1", { maxWaitMs: 5000 });
  c.useBehaviorSimulation({ scrolling: true });

  const workflow = c._buildWorkflow();
  assert.deepEqual(workflow.reverse.cloudflare, { maxWaitMs: 1500 });
  assert.equal(workflow.reverse.captcha.provider, "capsolver");
  assert.equal(workflow.reverse.captcha.apiKey, "CAP-1");
  assert.deepEqual(workflow.reverse.behaviorSimulation, { scrolling: true });

  const reverseConfig = buildReverseEngineConfigFromWorkflow(workflow);
  assert.deepEqual(reverseConfig.cloudflare, { maxWaitMs: 1500 });
  assert.equal(reverseConfig.captcha.provider, "capsolver");
  assert.deepEqual(reverseConfig.behaviorSim, { scrolling: true });
});

test("OmniCrawler auto-corrects identity drift during a real run", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: true,
      headers: req.headers,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/identity`;
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-identity-correct-"));

  try {
    const crawler = new OmniCrawler({ name: "identity-correct", projectRoot: root })
      .addRequests([{
        url,
        headers: {
          "user-agent": "BadUA/0.1",
          "accept-language": "en-US",
        },
      }])
      .setMode("http")
      .setIdentity({
        enabled: true,
        userAgent: "ExpectedUA/1.0",
        acceptLanguage: "zh-CN,zh",
        tlsProfile: "chrome-latest",
        h2Profile: "chrome-latest",
      });

    const summary = await crawler.run();
    const result = crawler._runner.completed[0];
    const diagnostics = summary.diagnostics;

    assert.equal(result.identity.userAgent, "ExpectedUA/1.0");
    assert.equal(result.identity.acceptLanguage, "zh-CN,zh");
    assert.equal(result.identity.tlsProfile, "chrome-latest");
    assert.equal(result.identity.h2Profile, "chrome-latest");
    assert.equal(result.identity.consistency.correctionCount >= 2, true);
    assert.equal(result.diagnostics.identityDriftDetected, true);
    assert.equal(result.diagnostics.identityCorrectionApplied, true);
    assert.equal(diagnostics.state.identityConsistency.correctionCount >= 2, true);
    assert.ok(diagnostics.suspects.some((entry) => entry.type === "identity-drift"));
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("pooled sessions reuse the bound identity profile across runs", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: true,
      headers: req.headers,
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/pool-identity`;
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-bound-identity-"));

  try {
    const firstCrawler = new OmniCrawler({ name: "bound-identity-first", projectRoot: root })
      .addSeedUrls(url)
      .setMode("http")
      .setSessionOptions({
        pool: {
          enabled: true,
          id: "shared-identity-pool",
          maxSessions: 1,
        },
      })
      .setIdentity({
        enabled: true,
        userAgent: "BoundUA/1.0",
        acceptLanguage: "zh-CN,zh",
        tlsProfile: "chrome-latest",
        h2Profile: "chrome-latest",
      });

    await firstCrawler.run();
    const firstResult = firstCrawler._runner.completed[0];
    assert.equal(firstResult.identity.userAgent, "BoundUA/1.0");

    const secondCrawler = new OmniCrawler({ name: "bound-identity-second", projectRoot: root })
      .addSeedUrls(url)
      .setMode("http")
      .setSessionOptions({
        pool: {
          enabled: true,
          id: "shared-identity-pool",
          maxSessions: 1,
        },
      })
      .setIdentity({
        enabled: true,
        userAgent: "DifferentUA/9.9",
        acceptLanguage: "fr-FR,fr",
        tlsProfile: "firefox-latest",
        h2Profile: "firefox-latest",
      });

    await secondCrawler.run();
    const secondResult = secondCrawler._runner.completed[0];

    assert.equal(secondResult.identity.userAgent, "BoundUA/1.0");
    assert.equal(secondResult.identity.acceptLanguage, "zh-CN,zh");
    assert.equal(secondResult.identity.tlsProfile, "chrome-latest");
    assert.equal(secondResult.identity.h2Profile, "chrome-latest");
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("CrawlContextImpl reverseEngine is null by default", () => {
  const ctx = new CrawlContextImpl({
    item: { url: "https://example.com" },
    response: { status: 200, headers: {} },
    extracted: null,
    runner: null,
  });
  assert.equal(ctx.reverseEngine, null);
});

test("CrawlContextImpl accepts reverseEngine param", () => {
  const engine = new ReverseEngine({ stealth: true });
  const ctx = new CrawlContextImpl({
    item: { url: "https://example.com" },
    response: { status: 200, headers: {} },
    extracted: null,
    runner: null,
    reverseEngine: engine,
  });
  assert.ok(ctx.reverseEngine instanceof ReverseEngine);
  assert.equal(ctx.reverseEngine.stealth, true);
});

test("CrawlContextImpl analysis methods return fallback when no engine", async () => {
  const ctx = new CrawlContextImpl({
    item: { url: "https://example.com" },
    response: { status: 200, headers: {} },
    extracted: null,
    runner: null,
  });
  const result = await ctx.analyzeJS("var x = 1");
  assert.equal(result.success, false);
  const aiResult = await ctx.analyzeAISurface({ code: "var x = 1" });
  assert.equal(aiResult.success, false);
});

test("CrawlContextImpl proxies AI surface analysis to the reverse engine", async () => {
  const engine = new ReverseEngine({ reverseAnalysis: true });
  const ctx = new CrawlContextImpl({
    item: { url: "https://example.com/page" },
    response: {
      status: 403,
      headers: { "cf-ray": "token" },
      body: '<html><body>verify you are human</body></html>',
      finalUrl: 'https://example.com/page',
    },
    extracted: null,
    runner: null,
    reverseEngine: engine,
  });

  const result = await ctx.analyzeAISurface({
    code: 'fetch("/api/ctx", { method: "GET" });',
    responseBody: '{"ok":true}',
  });

  assert.equal(result.kind, 'ai-surface-analysis');
  assert.equal(result.protection.waf.type, 'cloudflare');
  assert.ok(result.apiParameters.endpoints.includes('/api/ctx'));
});
