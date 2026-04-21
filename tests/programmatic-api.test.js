import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OmniCrawler,
  HttpCrawler,
  CheerioCrawler,
  BrowserCrawler,
  HybridCrawler,
  MediaCrawler,
  JSDOMCrawler,
  ApiJsonCrawler,
  FeedCrawler,
  SitemapCrawler,
  GraphQLCrawler,
  WebSocketCrawler,
  PuppeteerCrawler,
  PuppeteerCoreCrawler,
  PlaywrightCrawler,
  PlaywrightCoreCrawler,
  PatchrightCrawler,
  Router,
  ItemPipeline,
  CrawlContext,
  GracefulShutdown,
} from "../src/api/index.js";
import { validateWorkflow } from "../src/schemas/workflow-schema.js";
import { getCapabilities } from "../src/server.js";
import { DEFAULT_CONFIG, setGlobalConfig } from "../src/utils/config.js";

const require = createRequire(import.meta.url);
const { version: packageVersion } = require("../package.json");
const wsModule = require("ws");
const WebSocketServer = wsModule.WebSocketServer ?? wsModule.Server;

// --- Router Tests ---
test("Router matches glob", () => { const r = new Router(); r.addHandler("/p/*", () => {}); assert.ok(r.resolve("/p/1")); });
test("Router matches RegExp", () => { const r = new Router(); r.addHandler(/^\/api\/v\d+/, () => {}); assert.ok(r.resolve("/api/v1/u")); });
test("Router default handler", () => { const r = new Router(); let c = false; r.addDefaultHandler(() => { c = true; }); const m = r.resolve("/x"); assert.ok(m); m.handler({}); assert.equal(c, true); });
test("Router label resolve", () => { const r = new Router(); r.addHandler("/p/*", () => {}, { label: "p" }); assert.ok(r.hasLabel("p")); assert.equal(r.resolve("/o", "p").label, "p"); });
test("Router labels", () => { const r = new Router(); r.addHandler("/a/*", () => {}, { label: "a" }); r.addHandler("/b/*", () => {}, { label: "b" }); assert.deepEqual(r.labels().sort(), ["a", "b"]); });
test("Router null no match", () => { assert.equal(new Router().resolve("/n"), null); });

// --- ItemPipeline Tests ---
test("ItemPipeline process", async () => { const p = new ItemPipeline(); p.addStep(async (i) => { i.x = 1; return i; }); const r = await p.process({}); assert.ok(!r.dropped); assert.equal(r.item.x, 1); });
test("ItemPipeline drop null", async () => { const p = new ItemPipeline(); p.addStep(async () => null); assert.ok((await p.process({})).dropped); });
test("ItemPipeline stats", async () => { const p = new ItemPipeline(); p.addStep(async (i) => i); p.addStep(async (i) => i); await p.process({}); await p.process({}); const s = p.stats(); assert.equal(s.processed, 2); assert.equal(s.steps, 2); });
test("ItemPipeline addStep throws", () => { assert.throws(() => new ItemPipeline().addStep("x"), TypeError); });

// --- GracefulShutdown Tests ---
test("GracefulShutdown initial state", () => { assert.equal(new GracefulShutdown({ install: false }).isShuttingDown, false); });
test("GracefulShutdown runs callbacks", async () => { const s = new GracefulShutdown({ install: false, timeoutMs: 5000 }); let c = false; s.register(async () => { c = true; }); await s.shutdown(); assert.equal(c, true); assert.equal(s.isShuttingDown, true); });

// --- OmniCrawler Tests ---
test("OmniCrawler defaults", () => { const c = new OmniCrawler(); assert.equal(c.name, "default"); assert.equal(c.isRunning, false); assert.equal(c.lastSummary, null); });
test("OmniCrawler constructor honors global performance defaults", () => {
  setGlobalConfig({
    performance: {
      concurrency: 9,
      timeout: 8765,
    },
  });

  try {
    const crawler = new OmniCrawler();
    const workflow = crawler.addSeedUrls("https://example.com")._buildWorkflow();
    assert.equal(workflow.concurrency, 9);
    assert.equal(workflow.timeoutMs, 8765);
  } finally {
    setGlobalConfig(DEFAULT_CONFIG);
  }
});
test("crawler presets map to expected modes and engines", () => {
  assert.equal(new HttpCrawler().addSeedUrls("https://example.com")._buildWorkflow().mode, "http");
  assert.equal(new CheerioCrawler().addSeedUrls("https://example.com")._buildWorkflow().mode, "cheerio");
  assert.equal(new BrowserCrawler().addSeedUrls("https://example.com")._buildWorkflow().mode, "browser");
  assert.equal(new HybridCrawler().addSeedUrls("https://example.com")._buildWorkflow().mode, "hybrid");
  assert.equal(new MediaCrawler().addSeedUrls("https://example.com")._buildWorkflow().mode, "browser");
  assert.equal(new JSDOMCrawler().addSeedUrls("https://example.com")._buildWorkflow().mode, "http");
  assert.match(new ApiJsonCrawler().addSeedUrls("https://example.com")._buildWorkflow().headers.accept, /application\/json/);
  assert.match(new FeedCrawler().addSeedUrls("https://example.com")._buildWorkflow().headers.accept, /application\/rss\+xml/);
  assert.match(new SitemapCrawler().addSeedUrls("https://example.com")._buildWorkflow().headers.accept, /application\/xml/);
  assert.equal(new PuppeteerCrawler().addSeedUrls("https://example.com")._buildWorkflow().browser.engine, "puppeteer");
  assert.equal(new PuppeteerCoreCrawler().addSeedUrls("https://example.com")._buildWorkflow().browser.engine, "puppeteer-core");
  assert.equal(new PlaywrightCrawler().addSeedUrls("https://example.com")._buildWorkflow().browser.engine, "playwright");
  assert.equal(new PlaywrightCoreCrawler().addSeedUrls("https://example.com")._buildWorkflow().browser.engine, "playwright-core");
  assert.equal(new PatchrightCrawler().addSeedUrls("https://example.com")._buildWorkflow().browser.engine, "patchright");
});
test("MediaCrawler enables media extraction rules by default", () => {
  const workflow = new MediaCrawler()
    .addSeedUrls("https://example.com")
    ._buildWorkflow();

  assert.ok(Array.isArray(workflow.extract));
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "media"), true);
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "images"), true);
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "videos"), true);
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "audio"), true);
  assert.equal(workflow.browser.debug.captureNetwork, true);
});
test("crawler presets preserve explicit browser config overrides", () => {
  const workflow = new PlaywrightCrawler({
    browser: {
      headless: false,
      timeoutMs: 1234,
    },
  }).addSeedUrls("https://example.com")._buildWorkflow();

  assert.equal(workflow.mode, "browser");
  assert.equal(workflow.browser.engine, "playwright");
  assert.equal(workflow.browser.headless, false);
  assert.equal(workflow.browser.timeoutMs, 1234);
});
test("JSDOMCrawler builds xpath extract rules from a field map", () => {
  const workflow = new JSDOMCrawler()
    .addSeedUrls("https://example.com")
    .setXPathMap({
      title: "//title/text()",
      links: "//a/@href",
    }, { all: true })
    ._buildWorkflow();

  assert.equal(workflow.extract[0].type, "xpath");
  assert.equal(workflow.extract[0].xpath, "//title/text()");
  assert.equal(workflow.extract[1].type, "xpath");
  assert.equal(workflow.extract[1].all, true);
});
test("ApiJsonCrawler builds json extract rules from path map", () => {
  const workflow = new ApiJsonCrawler()
    .addSeedUrls("https://example.com/api")
    .setJsonPathMap({
      items: "data.items",
      nextCursor: "pageInfo.nextCursor",
    })
    ._buildWorkflow();

  assert.equal(workflow.mode, "http");
  assert.equal(workflow.extract[0].type, "json");
  assert.equal(workflow.extract[0].path, "data.items");
  assert.equal(workflow.extract[1].path, "pageInfo.nextCursor");
});
test("FeedCrawler and SitemapCrawler install feed/sitemap extraction presets", () => {
  const feedWorkflow = new FeedCrawler()
    .addSeedUrls("https://example.com/feed.xml")
    .useFeedExtraction()
    ._buildWorkflow();
  const sitemapWorkflow = new SitemapCrawler()
    .addSeedUrls("https://example.com/sitemap.xml")
    .useSitemapExtraction()
    ._buildWorkflow();

  assert.ok(feedWorkflow.extract.some((rule) => rule.name === "links"));
  assert.ok(sitemapWorkflow.extract.some((rule) => rule.name === "urls"));
  assert.ok(sitemapWorkflow.extract.some((rule) => rule.name === "sitemaps"));
  assert.equal(feedWorkflow.discovery.enabled, true);
  assert.equal(feedWorkflow.discovery.extractor.type, "script");
  assert.equal(sitemapWorkflow.discovery.enabled, true);
  assert.equal(sitemapWorkflow.discovery.extractor.type, "xpath");
  assert.equal(sitemapWorkflow.discovery.extractor.xml, true);
});
test("GraphQLCrawler detects endpoints, executes queries, and introspects schemas", async () => {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const payload = body ? JSON.parse(body) : {};

    res.setHeader("content-type", "application/json; charset=utf-8");
    if (String(payload.query ?? "").includes("IntrospectionQuery")) {
      res.end(JSON.stringify({
        data: {
          __schema: {
            queryType: { name: "Query" },
            mutationType: null,
            subscriptionType: null,
            types: [{
              name: "Query",
              kind: "OBJECT",
              description: null,
              fields: [{
                name: "viewer",
                type: { name: "String", kind: "SCALAR", ofType: null },
                args: [],
              }],
            }],
          },
        },
      }));
      return;
    }

    res.end(JSON.stringify({
      data: {
        viewer: `hello-${payload.variables?.name ?? "anon"}`,
        pageInfo: {
          hasNextPage: false,
          endCursor: null,
        },
      },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}/graphql`;

  try {
    const crawler = new GraphQLCrawler();
    const detected = crawler.detectEndpoints(`fetch("${endpoint}")`, endpoint);
    const executed = await crawler.execute({
      endpoint,
      query: "query Viewer($name: String!) { viewer(name: $name) }",
      variables: { name: "demo" },
    });
    const schema = await crawler.introspect(endpoint);

    assert.ok(detected.includes(endpoint));
    assert.equal(executed.data.viewer, "hello-demo");
    assert.equal(schema?.queryType, "Query");
    assert.equal(schema?.types[0].fields[0].name, "viewer");
  } finally {
    server.close();
    await once(server, "close");
  }
});
test("WebSocketCrawler connects and subscribes with preset options", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "ready" }));
    socket.on("message", (message) => {
      const text = message.toString("utf8");
      socket.send(JSON.stringify({ echo: text }));
    });
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `ws://127.0.0.1:${port}`;

  try {
    const crawler = new WebSocketCrawler().setWebSocketOptions({ collectMs: 200, maxMessages: 4 });
    const connected = await crawler.connect({
      url,
      sendMessage: { hello: "world" },
    });
    const subscribed = await crawler.subscribe(url, { subscribe: "demo" }, {
      collectMs: 200,
      maxMessages: 4,
    });

    assert.equal(connected.ok, true);
    assert.ok(connected.messages.some((item) => item.json?.type === "ready"));
    assert.ok(connected.messages.some((item) => item.text?.includes("hello")));
    assert.ok(subscribed.some((item) => item.json?.type === "ready"));
    assert.ok(subscribed.some((item) => item.text?.includes("subscribe")));
  } finally {
    await new Promise((resolve) => wss.close(resolve));
  }
});
test("WebSocketCrawler run() processes ws seeds through the unified crawler pipeline", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");

  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "ready" }));
    socket.on("message", () => {
      socket.send(JSON.stringify({ type: "update", value: 2 }));
    });
  });

  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const url = `ws://127.0.0.1:${port}`;
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-ws-run-"));

  try {
    const crawler = new WebSocketCrawler({ name: "ws-run", projectRoot: root })
      .setWebSocketOptions({
        sendMessage: { subscribe: "updates" },
        collectMs: 150,
        maxMessages: 4,
      })
      .addSeedUrls(url)
      .setExtractRules([{
        name: "messages",
        type: "json",
        path: "0.json.type",
      }]);

    const summary = await crawler.run();
    const items = await crawler.listItems();

    assert.equal(summary.status, "completed");
    assert.equal(summary.pagesFetched, 1);
    assert.equal(items.total, 0);

    const runDirFiles = await readdir(summary.runDir);
    assert.ok(runDirFiles.includes("results.ndjson"));
    const resultsText = await readFile(join(summary.runDir, "results.ndjson"), "utf8");
    assert.match(resultsText, /"mode":"websocket"/);
    assert.match(resultsText, /"type":"ready"/);
    assert.match(resultsText, /"type":"update"/);
  } finally {
    await new Promise((resolve) => wss.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
test("SitemapCrawler run() expands sitemap and sitemap index URLs into queued requests", async () => {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/sitemap.xml") {
      res.setHeader("content-type", "application/xml; charset=utf-8");
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex>
  <sitemap><loc>http://127.0.0.1:${server.address().port}/nested.xml</loc></sitemap>
  <sitemap><loc>http://127.0.0.1:${server.address().port}/page-a</loc></sitemap>
</sitemapindex>`);
      return;
    }
    if (path === "/nested.xml") {
      res.setHeader("content-type", "application/xml; charset=utf-8");
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>http://127.0.0.1:${server.address().port}/page-b</loc></url>
</urlset>`);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<html><head><title>${path}</title></head><body>${path}</body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-sitemap-run-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const summary = await new SitemapCrawler({ name: "sitemap-run", projectRoot: root })
      .addSeedUrls(`${baseUrl}/sitemap.xml`)
      .run();

    assert.equal(summary.status, "completed");
    assert.ok(summary.pagesFetched >= 3);

    const resultsText = await readFile(join(summary.runDir, "results.ndjson"), "utf8");
    assert.match(resultsText, /nested\.xml/);
    assert.match(resultsText, /page-a/);
    assert.match(resultsText, /page-b/);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("FeedCrawler run() follows feed item links", async () => {
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    if (path === "/feed.xml") {
      res.setHeader("content-type", "application/rss+xml; charset=utf-8");
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item><title>A</title><link>http://127.0.0.1:${server.address().port}/news/a</link></item>
    <item><title>B</title><link>http://127.0.0.1:${server.address().port}/news/b</link></item>
  </channel>
</rss>`);
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<html><head><title>${path}</title></head><body>${path}</body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-feed-run-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const summary = await new FeedCrawler({ name: "feed-run", projectRoot: root })
      .addSeedUrls(`${baseUrl}/feed.xml`)
      .run();

    assert.equal(summary.status, "completed");
    assert.ok(summary.pagesFetched >= 3);

    const resultsText = await readFile(join(summary.runDir, "results.ndjson"), "utf8");
    assert.match(resultsText, /news\/a/);
    assert.match(resultsText, /news\/b/);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("OmniCrawler fluent chain", () => { const c = new OmniCrawler(); assert.equal(c.addSeedUrls("https://example.com").setMode("http").setConcurrency(2).setMaxDepth(1).setTimeout(10000).setHeaders({"X":"1"}), c); });
test("OmniCrawler setMode throws", () => { assert.throws(() => new OmniCrawler().setMode("ftp"), /Invalid mode/); });
test("OmniCrawler concurrency range", () => { assert.throws(() => new OmniCrawler().setConcurrency(0), /between 1 and 20/); assert.throws(() => new OmniCrawler().setConcurrency(25), /between 1 and 20/); });
test("OmniCrawler maxDepth range", () => { assert.throws(() => new OmniCrawler().setMaxDepth(-1), /between 0 and 10/); assert.throws(() => new OmniCrawler().setMaxDepth(15), /between 0 and 10/); });
test("OmniCrawler useRouter type", () => { assert.throws(() => new OmniCrawler().useRouter({}), /Router instance/); const c2 = new OmniCrawler(); assert.equal(c2.useRouter(new Router()), c2); });
test("OmniCrawler useItemPipeline type", () => { assert.throws(() => new OmniCrawler().useItemPipeline({}), /ItemPipeline instance/); const c = new OmniCrawler(); assert.equal(c.useItemPipeline(new ItemPipeline()), c); });
test("OmniCrawler gracefulShutdown", () => { const c = new OmniCrawler(); assert.equal(c.gracefulShutdown({ timeoutMs: 5000 }), c); });
test("OmniCrawler buildWorkflow no seeds", () => { assert.throws(() => new OmniCrawler()._buildWorkflow(), /No seed URLs/); });
test("OmniCrawler buildWorkflow valid", () => { const w = new OmniCrawler({name:"t"}).addSeedUrls("https://example.com").setMode("http").setConcurrency(2).setMaxDepth(1)._buildWorkflow(); assert.equal(w.name, "t"); assert.deepEqual(w.seedUrls, ["https://example.com"]); assert.equal(w.concurrency, 2); });
test("OmniCrawler buildWorkflow preserves seed request metadata", () => {
  const workflow = new OmniCrawler({ name: "seed-requests" })
    .addRequests([{
      url: "https://example.com/api",
      method: "POST",
      body: "{\"page\":1}",
      headers: { "content-type": "application/json" },
      label: "api-seed",
      priority: 90,
      userData: { entry: "catalog" },
      metadata: { source: "bootstrap" },
    }])
    ._buildWorkflow();

  assert.deepEqual(workflow.seedUrls, ["https://example.com/api"]);
  assert.equal(workflow.seedRequests.length, 1);
  assert.equal(workflow.seedRequests[0].method, "POST");
  assert.equal(workflow.seedRequests[0].label, "api-seed");
  assert.equal(workflow.seedRequests[0].priority, 90);
  assert.equal(workflow.seedRequests[0].userData.entry, "catalog");
});
test("OmniCrawler buildWorkflow proxy", () => { assert.equal(new OmniCrawler().addSeedUrls("https://example.com").useProxy("http://p:8")._buildWorkflow().proxy.server, "http://p:8"); });
test("OmniCrawler buildWorkflow output uses schema-compatible keys", () => {
  const workflow = new OmniCrawler({ name: "out" }).addSeedUrls("https://example.com")._buildWorkflow();
  assert.ok(workflow.output.dir.startsWith("runs/out-"));
  assert.equal(workflow.output.console, true);
});
test("Workflow schema accepts cheerio mode", () => {
  const workflow = validateWorkflow({
    name: "cheerio-workflow",
    seedUrls: ["https://example.com"],
    mode: "cheerio",
  });
  assert.equal(workflow.mode, "cheerio");
});
test("Workflow schema accepts seedRequests", () => {
  const workflow = validateWorkflow({
    name: "seed-requests",
    seedUrls: ["https://example.com/api"],
    seedRequests: [{
      url: "https://example.com/api",
      method: "POST",
      label: "api-seed",
      headers: { "content-type": "application/json" },
      userData: { entry: "catalog" },
    }],
    mode: "http",
  });

  assert.equal(workflow.seedRequests.length, 1);
  assert.equal(workflow.seedRequests[0].method, "POST");
  assert.equal(workflow.seedRequests[0].label, "api-seed");
  assert.equal(workflow.seedRequests[0].userData.entry, "catalog");
});
test("Workflow schema normalizes proxy.url to proxy.server", () => {
  const workflow = validateWorkflow({
    name: "proxy-alias",
    seedUrls: ["https://example.com"],
    proxy: { url: "http://127.0.0.1:8080" },
  });
  assert.equal(workflow.proxy.server, "http://127.0.0.1:8080");
  assert.equal("url" in workflow.proxy, false);
});
test("Workflow schema normalizes output.directory to output.dir", () => {
  const workflow = validateWorkflow({
    name: "output-alias",
    seedUrls: ["https://example.com"],
    output: { directory: "artifacts" },
  });
  assert.equal(workflow.output.dir, "artifacts");
  assert.equal("directory" in workflow.output, false);
});
test("Workflow schema accepts rateLimiter config", () => {
  const workflow = validateWorkflow({
    name: "throttle",
    seedUrls: ["https://example.com"],
    rateLimiter: {
      requestsPerSecond: 2,
      autoThrottle: { enabled: true },
    },
  });
  assert.equal(workflow.rateLimiter.requestsPerSecond, 2);
  assert.equal(workflow.rateLimiter.autoThrottle.enabled, true);
});
test("Workflow schema defaults maxConcurrent to burstSize when omitted", () => {
  const workflow = validateWorkflow({
    name: "throttle-burst-default",
    seedUrls: ["https://example.com"],
    rateLimiter: {
      requestsPerSecond: 2,
      burstSize: 4,
    },
  });

  assert.equal(workflow.rateLimiter.burstSize, 4);
  assert.equal(workflow.rateLimiter.maxConcurrent, 4);
});
test("Workflow schema accepts xpath extractor rules", () => {
  const workflow = validateWorkflow({
    name: "xpath-workflow",
    seedUrls: ["https://example.com"],
    extract: [{
      name: "title",
      type: "xpath",
      xpath: "//title/text()",
      xml: false,
    }],
  });

  assert.equal(workflow.extract[0].type, "xpath");
  assert.equal(workflow.extract[0].xpath, "//title/text()");
});
test("Capabilities version stays aligned with package version", () => {
  const capabilities = getCapabilities();
  assert.equal(capabilities.version, packageVersion);
  assert.ok(capabilities.fetchers.includes("cheerio"));
  assert.equal(capabilities.surfaces.reverse.importPath, "omnicrawl/reverse");
  assert.equal(capabilities.compliance.reverseModulesOptIn, true);
});
test("OmniCrawler buildWorkflow overrides", () => { const w = new OmniCrawler().addSeedUrls("https://example.com").setRetryOptions({maxAttempts:5}).setBrowserOptions({headless:true})._buildWorkflow(); assert.deepEqual(w.retry, {maxAttempts:5}); assert.deepEqual(w.browser, {headless:true}); });
test("OmniCrawler useMediaExtraction appends media rules and enables browser network capture", () => {
  const workflow = new OmniCrawler()
    .addSeedUrls("https://example.com")
    .setExtractRules([{ name: "title", type: "regex", pattern: "<title>([^<]+)</title>" }])
    .useMediaExtraction({ includeAudio: false, format: "object", maxItems: 99 })
    ._buildWorkflow();

  assert.equal(workflow.extract[0].name, "title");
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "media"), true);
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "images"), true);
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "videos"), true);
  assert.equal(workflow.extract.some((rule) => rule.type === "media" && rule.name === "audio"), false);
  assert.equal(workflow.browser.debug.captureNetwork, true);
  assert.equal(workflow.browser.debug.maxRequests, 200);
});
test("OmniCrawler useMediaDownload auto-enables media extraction and downloads files", async () => {
  const binary = Buffer.from("fake-image-binary");
  const server = createServer((req, res) => {
    if (req.url === "/image.jpg") {
      res.setHeader("content-type", "image/jpeg");
      res.setHeader("content-disposition", 'inline; filename="hero.jpg"');
      res.end(binary);
      return;
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(`<html><body><img src="/image.jpg" alt="hero" /></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-media-download-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const crawler = new OmniCrawler({ name: "media-download", projectRoot: root })
      .addSeedUrls(`${baseUrl}/`)
      .setMode("http")
      .useMediaDownload({
        outputDir: "artifacts/media",
        includeNetwork: false,
      });

    const summary = await crawler.run();
    assert.equal(summary.status, "completed");

    const downloadedFiles = await readdir(join(root, "artifacts", "media", "image"));
    assert.ok(downloadedFiles.includes("hero.jpg"));
    const manifest = await readFile(join(root, "artifacts", "media", "downloads.ndjson"), "utf8");
    assert.match(manifest, /hero\.jpg/);

    const records = await crawler.listRecords();
    assert.ok(records.some((record) => record.key.startsWith("MEDIA_DOWNLOADS:")));
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("OmniCrawler useMediaDownload writes failed downloads to the default failures manifest", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/image.jpg") {
      res.setHeader("content-type", "image/jpeg");
      res.end(Buffer.from("fake-image-binary"));
      return;
    }

    if (req.url === "/broken.jpg") {
      res.statusCode = 503;
      res.end("retry");
      return;
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end('<html><body><img src="/image.jpg" alt="hero" /><img src="/broken.jpg" alt="broken" /></body></html>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-media-download-failures-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const crawler = new OmniCrawler({ name: "media-download-failures", projectRoot: root })
      .addSeedUrls(`${baseUrl}/`)
      .setMode("http")
      .useMediaDownload({
        outputDir: "artifacts/media",
        includeNetwork: false,
        retryAttempts: 1,
      });

    const summary = await crawler.run();
    assert.equal(summary.status, "completed");

    const failuresManifest = await readFile(join(root, "artifacts", "media", "failed-downloads.ndjson"), "utf8");
    assert.match(failuresManifest, /broken\.jpg/);
    assert.doesNotMatch(failuresManifest, /image\.jpg/);

    const records = await crawler.listRecords();
    const downloadRecord = records.find((record) => record.key.startsWith("MEDIA_DOWNLOADS:"));
    const downloadSummary = await crawler.getValue(downloadRecord?.key);
    assert.equal(downloadSummary?.failed, 1);
    assert.equal(downloadSummary?.failuresPath, join(root, "artifacts", "media", "failed-downloads.ndjson"));
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("OmniCrawler lifecycle chain", () => { const c = new OmniCrawler(); assert.equal(c.onReady(()=>{}).onIdle(()=>{}).onComplete(()=>{}).onError(()=>{}), c); });
test("OmniCrawler usePlugin is fluent and validates input", () => {
  const crawler = new OmniCrawler();
  assert.equal(crawler.usePlugin({ name: "tracker" }), crawler);
  assert.throws(() => new OmniCrawler().usePlugin(null), /plugin object or async plugin factory/);
});
test("OmniCrawler useMiddleware is fluent and validates input", () => {
  const crawler = new OmniCrawler();
  assert.equal(crawler.useMiddleware({}), crawler);
  assert.throws(() => new OmniCrawler().useMiddleware(null), /Middleware config must be an object/);
});
test("OmniCrawler snapshot idle", () => { const s = new OmniCrawler({name:"s"}).snapshot(); assert.equal(s.status, "idle"); assert.equal(s.name, "s"); });
test("OmniCrawler useMiddleware runtime hooks participate in request lifecycle", async () => {
  let receivedHeader = null;
  const server = createServer((req, res) => {
    receivedHeader = req.headers["x-runtime-middleware"] ?? null;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Runtime Middleware</title></head><body>ok</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-runtime-middleware-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const seen = [];

  try {
    const summary = await new OmniCrawler({ name: "runtime-middleware", projectRoot: root })
      .addSeedUrls(`${baseUrl}/middleware`)
      .setMode("http")
      .setMaxDepth(0)
      .useMiddleware({
        runtime: {
          async beforeRequest({ request }) {
            request.headers = request.headers ?? {};
            request.headers["x-runtime-middleware"] = "enabled";
            seen.push(`before:${request.url}`);
          },
          async afterResponse({ response }) {
            seen.push(`after:${response.status}`);
          },
        },
      })
      .run();

    assert.equal(summary.status, "completed");
    assert.equal(receivedHeader, "enabled");
    assert.deepEqual(seen, [`before:${baseUrl}/middleware`, "after:200"]);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("OmniCrawler useMiddleware route hooks wrap handlers and receive handler errors", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Route Middleware</title></head><body>ok</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-route-middleware-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const seen = [];

  try {
    const router = new Router().addHandler("/ok/:id", async (ctx) => {
      seen.push(`handler:${ctx.params.id}`);
      await ctx.pushData({ id: ctx.params.id });
    }, { label: "ok" }).addHandler("/boom/:id", async (ctx) => {
      seen.push(`handler-error:${ctx.params.id}`);
      throw new Error(`boom:${ctx.params.id}`);
    }, { label: "boom" });

    const crawler = new OmniCrawler({ name: "route-middleware", projectRoot: root })
      .addRequests([
        { url: `${baseUrl}/ok/42`, label: "ok" },
        { url: `${baseUrl}/boom/7`, label: "boom" },
      ])
      .setMode("http")
      .setConcurrency(1)
      .setMaxDepth(0)
      .useRouter(router)
      .useMiddleware({
        route: {
          async beforeRequest(ctx) {
            seen.push(`before:${ctx.params.id}`);
          },
          async afterResponse(ctx) {
            seen.push(`after:${ctx.params.id}`);
          },
          async onError(ctx, error) {
            seen.push(`error:${ctx.params.id}:${error.message}`);
          },
        },
      });

    const summary = await crawler.run();
    const items = await crawler.listItems();

    assert.equal(summary.status, "completed");
    assert.equal(summary.requestsFailed, 0);
    assert.equal(items.total, 1);
    assert.equal(items.items[0].id, "42");
    assert.deepEqual(seen, [
      "before:42",
      "handler:42",
      "after:42",
      "before:7",
      "handler-error:7",
      "error:7:boom:7",
    ]);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("OmniCrawler programmatic plugins run request and response hooks", async () => {
  let receivedHeader = null;
  const server = createServer((req, res) => {
    receivedHeader = req.headers["x-programmatic-plugin"] ?? null;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Plugin Hook</title></head><body>ok</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-plugin-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const seen = [];

  try {
    const summary = await new OmniCrawler({ name: "plugin-hooks", projectRoot: root })
      .addSeedUrls(`${baseUrl}/hooked`)
      .setMode("http")
      .setMaxDepth(0)
      .usePlugin({
        name: "hook-tracker",
        async beforeRequest({ request }) {
          request.headers = request.headers ?? {};
          request.headers["x-programmatic-plugin"] = "enabled";
          seen.push(`before:${request.url}`);
        },
        async afterResponse({ response }) {
          seen.push(`after:${response.status}`);
        },
      })
      .run();

    assert.equal(summary.status, "completed");
    assert.equal(receivedHeader, "enabled");
    assert.deepEqual(seen, [`before:${baseUrl}/hooked`, "after:200"]);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});
test("OmniCrawler programmatic plugins receive onError hooks", async () => {
  const server = createServer((req, res) => {
    req.socket.destroy();
    res.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-error-plugin-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const seen = [];

  try {
    const summary = await new OmniCrawler({ name: "plugin-errors", projectRoot: root })
      .addSeedUrls(`${baseUrl}/boom`)
      .setMode("http")
      .setMaxDepth(0)
      .usePlugin({
        name: "error-tracker",
        async onError({ error, request, attempt }) {
          seen.push({
            url: request.url,
            attempt,
            message: error.message,
          });
        },
      })
      .run();

    assert.equal(summary.status, "completed");
    assert.equal(summary.requestsFailed, 1);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, `${baseUrl}/boom`);
    assert.equal(seen[0].attempt, 1);
    assert.ok(seen[0].message.length > 0);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("OmniCrawler browser navigation hooks can shape page state around goto", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Navigation Hooks</title></head><body><main id=\"app\">ready</main></body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-browser-navigation-hooks-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const seen = [];

  try {
    const summary = await new OmniCrawler({ name: "browser-navigation-hooks", projectRoot: root })
      .addSeedUrls(`${baseUrl}/page`)
      .setMode("browser")
      .setMaxDepth(0)
      .setBrowserOptions({ headless: true, waitUntil: "domcontentloaded" })
      .usePlugin({
        name: "navigation-hooks",
        async beforeNavigation({ page }) {
          await page.evaluateOnNewDocument(() => {
            window.__omnicrawlBeforeNavigation = "armed";
          });
          seen.push("before");
        },
        async afterNavigation({ page, response }) {
          seen.push(await page.evaluate(() => window.__omnicrawlBeforeNavigation ?? "missing"));
          seen.push(`status:${response.status}`);
          seen.push(await page.$eval("#app", (node) => node.textContent));
        },
      })
      .run();

    assert.equal(summary.status, "completed");
    assert.deepEqual(seen, ["before", "armed", "status:200", "ready"]);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("OmniCrawler onFailedRequest fires once after retries are exhausted", async () => {
  const server = createServer((req, res) => {
    req.socket.destroy();
    res.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-failed-request-handler-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const attempts = [];
  const failures = [];
  const crawler = new OmniCrawler({ name: "failed-request-handler", projectRoot: root })
    .addSeedUrls(`${baseUrl}/boom`)
    .setMode("http")
    .setMaxDepth(0)
    .setRetryOptions({ attempts: 2 })
    .usePlugin({
      name: "attempt-tracker",
      async onError({ attempt, request }) {
        attempts.push(`${attempt}:${request.url}`);
      },
    })
    .onFailedRequest((ctx) => {
      failures.push({
        attempt: ctx.attempt,
        message: ctx.error.message,
        url: ctx.request.url,
        response: ctx.response,
      });
    });

  try {
    const summary = await crawler.run();
    const failedRequests = await crawler.listFailedRequests();
    const recipe = await crawler.getReplayRecipe();

    assert.equal(summary.status, "completed");
    assert.equal(summary.requestsFailed, 1);
    assert.equal(summary.failedRequestCount, 1);
    assert.deepEqual(attempts, [`1:${baseUrl}/boom`, `2:${baseUrl}/boom`]);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].attempt, 2);
    assert.equal(failures[0].url, `${baseUrl}/boom`);
    assert.equal(failures[0].response, null);
    assert.ok(failures[0].message.length > 0);
    assert.equal(failedRequests.total, 1);
    assert.equal(failedRequests.items[0].url, `${baseUrl}/boom`);
    assert.equal(failedRequests.items[0].attempt, 2);
    assert.equal(failedRequests.items[0].status, null);
    assert.ok(failedRequests.items[0].error.length > 0);
    assert.ok(recipe);
    assert.equal(recipe.version, 1);
    assert.equal(recipe.recommendedMode, "http");
    assert.ok(Array.isArray(recipe.steps));
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("OmniCrawler deduplicator respects request method/body uniqueness settings", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    requests.push({
      method: req.method,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-dedup-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const summary = await new OmniCrawler({ name: "programmatic-dedup", projectRoot: root })
      .addRequests([
        {
          url: `${baseUrl}/graphql`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{\"page\":1}",
        },
        {
          url: `${baseUrl}/graphql`,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{\"page\":2}",
        },
      ])
      .setMode("http")
      .setRequestQueueOptions({
        includeMethodInUniqueKey: true,
        includeBodyInUniqueKey: true,
      })
      .useDeduplicator({
        includeMethodInUniqueKey: true,
        includeBodyInUniqueKey: true,
      })
      .run();

    assert.equal(summary.pagesFetched, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((entry) => entry.body), ["{\"page\":1}", "{\"page\":2}"]);
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("OmniCrawler persists programmatic reverse helpers into workflow snapshots", async () => {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<html><head><title>Reverse Snapshot</title></head><body>ok</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-reverse-snapshot-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const summary = await new OmniCrawler({ name: "programmatic-reverse-snapshot", projectRoot: root })
      .addSeedUrls(`${baseUrl}/reverse-snapshot`)
      .setMode("http")
      .useCloudflareSolver({ maxWaitMs: 2500 })
      .useCaptchaSolver("capsolver", "CAP-2", { maxWaitMs: 7000 })
      .useBehaviorSimulation({ typing: true })
      .run();

    const snapshotRaw = await readFile(join(summary.runDir, "workflow.json"), "utf8");
    const snapshot = JSON.parse(snapshotRaw);

    assert.deepEqual(snapshot.workflow.reverse.cloudflare, { maxWaitMs: 2500 });
    assert.equal(snapshot.workflow.reverse.captcha.provider, "capsolver");
    assert.equal(snapshot.workflow.reverse.captcha.apiKey, "CAP-2");
    assert.deepEqual(snapshot.workflow.reverse.behaviorSimulation, { typing: true });
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test("OmniCrawler exposes rich run summary, dataset items, and key-value records", async () => {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end("<html><head><title>Detail</title></head><body>detail</body></html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "omnicrawl-programmatic-stores-"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const router = new Router().addHandler("/items/:id", async (ctx) => {
      const previous = await ctx.inputValue("seen");
      const nextCount = Number(previous?.count ?? 0) + 1;
      await ctx.setValue("seen", { count: nextCount, lastId: ctx.params.id });
      await ctx.pushData({
        id: ctx.params.id,
        visits: nextCount,
        finalUrl: ctx.finalUrl,
      });
    }, { label: "detail" });

    const crawler = new OmniCrawler({ name: "store-surface", projectRoot: root })
      .addRequests({
        url: `${baseUrl}/items/42`,
        label: "detail",
        userData: { source: "seed" },
      })
      .setMode("http")
      .useRouter(router);

    const summary = await crawler.run();

    assert.equal(summary.status, "completed");
    assert.equal(summary.name, "store-surface");
    assert.equal(summary.pagesFetched, 1);
    assert.equal(summary.itemsPushed, 1);
    assert.equal(summary.requestsFailed, 0);
    assert.ok(summary.jobId);
    assert.ok(summary.runDir);
    assert.match(summary.datasetId, new RegExp(`^${summary.jobId}:items$`));
    assert.match(summary.keyValueStoreId, new RegExp(`^${summary.jobId}:state$`));
    assert.equal(summary.systemKeyValueStoreId, summary.jobId);
    assert.ok(summary.queue);
    assert.equal(crawler.jobId, summary.jobId);
    assert.equal(crawler.runDir, summary.runDir);
    assert.equal(crawler.systemKeyValueStoreId, summary.systemKeyValueStoreId);
    assert.equal(crawler.snapshot().jobId, summary.jobId);
    assert.equal(crawler.snapshot().datasetId, summary.datasetId);

    const datasetInfo = await crawler.getDatasetInfo();
    assert.equal(datasetInfo.id, summary.datasetId);
    assert.equal(datasetInfo.itemCount, 1);

    const items = await crawler.listItems();
    assert.equal(items.total, 1);
    assert.equal(items.items[0].id, "42");
    assert.equal(items.items[0].visits, 1);

    const kvInfo = await crawler.getKeyValueInfo();
    assert.equal(kvInfo.id, summary.keyValueStoreId);
    assert.ok(kvInfo.recordCount >= 1);

    const records = await crawler.listRecords();
    assert.ok(records.some((record) => record.key === "seen"));
    assert.equal(records.some((record) => record.key === "SUMMARY"), false);

    assert.deepEqual(await crawler.getValue("seen"), { count: 1, lastId: "42" });
    await crawler.setValue("manual", { ready: true });
    assert.deepEqual(await crawler.getValue("manual"), { ready: true });
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

// --- CrawlContext Tests ---
test("CrawlContext request/response", () => { const c = new CrawlContext({ item: {url:"https://example.com",method:"GET",depth:0,userData:{}}, response: {status:200,headers:{"content-type":"text/html"},body:"<html></html>"}, extracted: {}, runner: null }); assert.equal(c.request.url, "https://example.com"); assert.equal(c.status, 200); assert.ok(c.ok); assert.equal(c.body, "<html></html>"); });


// --- CrawlContext drainItems Tests ---
test("CrawlContext drainItems without pipeline", async () => {
  const c = new CrawlContext({
    item: { url: "https://example.com", method: "GET", depth: 0, userData: {} },
    response: { status: 200, body: "ok" },
    extracted: {},
    runner: null,
  });
  await c.pushData({ title: "test1" });
  await c.pushData({ title: "test2" });
  const items = await c.drainItems();
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "test1");
  assert.equal(items[1].title, "test2");
  assert.equal(items[0]._url, "https://example.com");
  // After drain, pending items should be empty
  const items2 = await c.drainItems();
  assert.equal(items2.length, 0);
});

test("CrawlContext drainItems with pipeline", async () => {
  const c = new CrawlContext({
    item: { url: "https://example.com", method: "GET", depth: 0, userData: {} },
    response: { status: 200, body: "ok" },
    extracted: {},
    runner: null,
  });
  await c.pushData({ title: "keep" });
  await c.pushData({ title: "drop" });
  const pipeline = new ItemPipeline();
  pipeline.addStep(async (item) => {
    if (item.title === "drop") return null; // drop this item
    item.processed = true;
    return item;
  });
  const items = await c.drainItems(pipeline);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "keep");
  assert.equal(items[0].processed, true);
});

test("CrawlContext enqueue resolves relative URLs and preserves metadata", async () => {
  const captured = [];
  const c = new CrawlContext({
    item: {
      url: "https://example.com/products/1?ref=home",
      method: "GET",
      depth: 1,
      userData: { section: "products" },
      metadata: {},
    },
    response: { status: 200, finalUrl: "https://example.com/products/1?ref=home" },
    extracted: {},
    runner: {
      enqueue: async (item) => {
        captured.push(item);
        return true;
      },
      keyValueStore: { getRecord: async () => null, setRecord: async () => {} },
      pagesFetched: 0,
      resultCount: 0,
      failureCount: 0,
      skippedCount: 0,
      autoscaler: { snapshot: () => null },
      requestQueue: { summary: () => null },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  });

  const added = await c.enqueue("../next", {
    label: "detail",
    metadata: { sourceField: "pagination" },
  });

  assert.equal(added, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://example.com/next");
  assert.equal(captured[0].parentUrl, "https://example.com/products/1?ref=home");
  assert.equal(captured[0].depth, 2);
  assert.equal(captured[0].label, "detail");
  assert.equal(captured[0].metadata.parentLabel, null);
  assert.equal(captured[0].metadata.sourceField, "pagination");
});

test("CrawlContext enqueue accepts request objects with rich request options", async () => {
  const captured = [];
  const c = new CrawlContext({
    item: {
      url: "https://example.com/products/1?ref=home",
      method: "GET",
      depth: 1,
      userData: { section: "products" },
      metadata: {},
    },
    response: { status: 200, finalUrl: "https://example.com/products/1?ref=home" },
    extracted: {},
    runner: {
      enqueue: async (item) => {
        captured.push(item);
        return true;
      },
      keyValueStore: { getRecord: async () => null, setRecord: async () => {} },
      pagesFetched: 0,
      resultCount: 0,
      failureCount: 0,
      skippedCount: 0,
      autoscaler: { snapshot: () => null },
      requestQueue: { summary: () => null },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  });

  const added = await c.enqueue({
    url: "../submit",
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{\"page\":2}",
    priority: 77,
    uniqueKey: "custom-submit",
    userData: { fromRequest: true },
    metadata: { sourceField: "pagination" },
    label: "detail",
  }, {
    userData: { fromOptions: true },
    metadata: { via: "ctx.enqueue" },
  });

  assert.equal(added, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://example.com/submit");
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].headers["content-type"], "application/json");
  assert.equal(captured[0].body, "{\"page\":2}");
  assert.equal(captured[0].priority, 77);
  assert.equal(captured[0].uniqueKey, "custom-submit");
  assert.equal(captured[0].label, "detail");
  assert.deepEqual(captured[0].userData, { fromRequest: true, fromOptions: true });
  assert.equal(captured[0].metadata.parentLabel, null);
  assert.equal(captured[0].metadata.sourceField, "pagination");
  assert.equal(captured[0].metadata.via, "ctx.enqueue");
});

test("CrawlContext enqueue inherits replayState from the current response", async () => {
  const captured = [];
  const c = new CrawlContext({
    item: {
      url: "https://example.com/bootstrap",
      method: "GET",
      depth: 0,
      userData: {},
      metadata: {},
    },
    response: {
      status: 200,
      finalUrl: "https://example.com/bootstrap",
      replayState: {
        authToken: "beta",
      },
    },
    extracted: {},
    runner: {
      enqueue: async (item) => {
        captured.push(item);
        return true;
      },
      keyValueStore: { getRecord: async () => null, setRecord: async () => {} },
      pagesFetched: 0,
      resultCount: 0,
      failureCount: 0,
      skippedCount: 0,
      autoscaler: { snapshot: () => null },
      requestQueue: { summary: () => null },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  });

  const added = await c.enqueue("/next");

  assert.equal(added, true);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].replayState, {
    authToken: "beta",
  });
});

test("CrawlContext enqueueExtractedLinks batches extracted links", async () => {
  const captured = [];
  const c = new CrawlContext({
    item: { url: "https://example.com/list", method: "GET", depth: 0, userData: {}, metadata: {} },
    response: { status: 200, finalUrl: "https://example.com/list" },
    extracted: {
      links: ["/a", "/b", "/a"],
    },
    runner: {
      enqueue: async (item) => {
        captured.push(item.url);
        return true;
      },
      keyValueStore: { getRecord: async () => null, setRecord: async () => {} },
      pagesFetched: 0,
      resultCount: 0,
      failureCount: 0,
      skippedCount: 0,
      autoscaler: { snapshot: () => null },
      requestQueue: { summary: () => null },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  });

  const count = await c.enqueueExtractedLinks();
  assert.equal(count, 2);
  assert.deepEqual(captured, ["https://example.com/a", "https://example.com/b"]);
});

test("CrawlContext ok getter derives from status", () => {
  const c200 = new CrawlContext({
    item: { url: "https://example.com", depth: 0, userData: {} },
    response: { status: 200 },
    extracted: {},
    runner: null,
  });
  assert.equal(c200.ok, true);

  const c404 = new CrawlContext({
    item: { url: "https://example.com", depth: 0, userData: {} },
    response: { status: 404 },
    extracted: {},
    runner: null,
  });
  assert.equal(c404.ok, false);

  const c301 = new CrawlContext({
    item: { url: "https://example.com", depth: 0, userData: {} },
    response: { status: 301 },
    extracted: {},
    runner: null,
  });
  assert.equal(c301.ok, true);

  // When response.ok is explicitly set, use it
  const cExplicit = new CrawlContext({
    item: { url: "https://example.com", depth: 0, userData: {} },
    response: { status: 200, ok: false },
    extracted: {},
    runner: null,
  });
  assert.equal(cExplicit.ok, false);
});

test("CrawlContext null runner does not crash", async () => {
  const c = new CrawlContext({
    item: { url: "https://example.com", depth: 0, userData: {} },
    response: { status: 200, body: "ok" },
    extracted: {},
    runner: null,
  });
  // Should not throw when runner is null (logger is stubbed)
  assert.ok(c.log);
  assert.equal(typeof c.log.info, "function");
  // pushData should work without runner
  await c.pushData({ test: true });
  const items = await c.drainItems();
  assert.equal(items.length, 1);
});

// --- ItemPipeline steps() Test ---
test("ItemPipeline steps returns copy", () => {
  const p = new ItemPipeline();
  const step1 = async (i) => i;
  const step2 = async (i) => i;
  p.addStep(step1);
  p.addStep(step2);
  const steps = p.steps();
  assert.equal(steps.length, 2);
  // Mutating the returned array should not affect the pipeline
  steps.push(async (i) => i);
  assert.equal(p.steps().length, 2);
});


// --- Additional Error Handling Tests ---
test("CrawlContext drainItems pipeline step throws", async () => {
  const c = new CrawlContext({
    item: { url: "https://example.com", depth: 0, userData: {} },
    response: { status: 200, body: "ok" },
    extracted: {},
    runner: null,
  });
  await c.pushData({ title: "good" });
  await c.pushData({ title: "boom" });
  await c.pushData({ title: "also-good" });
  const pipeline = new ItemPipeline();
  pipeline.addStep(async (item) => {
    if (item.title === "boom") throw new Error("pipeline kaboom");
    item.processed = true;
    return item;
  });
  const items = await c.drainItems(pipeline);
  // Throwing item is silently excluded; other items pass through
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "good");
  assert.equal(items[0].processed, true);
  assert.equal(items[1].title, "also-good");
  assert.equal(items[1].processed, true);
  // Pipeline stats should reflect the error
  const stats = pipeline.stats();
  assert.equal(stats.errors, 1);
  assert.equal(stats.processed, 2);
});

test("OmniCrawler _processPage handler error is caught", async () => {
  const crawler = new OmniCrawler({ name: "err-test" });
  crawler.addSeedUrls(["https://example.com"]);
  const router = new Router();
  router.addHandler("/", async (ctx) => {
    throw new Error("handler blew up");
  });
  crawler.useRouter(router);
  // Simulate the internal _processPage call
  const result = await crawler._processPage(
    { url: "https://example.com/", method: "GET", depth: 0, userData: {} },
    { status: 200, body: "<html></html>" },
    null
  );
  // Handler error should be caught, returning null instead of propagating
  assert.equal(result, null);
});


test("OmniCrawler _processPage happy path returns items", async () => {
  const crawler = new OmniCrawler({ name: "happy-test" });
  crawler.addSeedUrls(["https://example.com"]);
  const router = new Router();
  router.addHandler("/", async (ctx) => {
    await ctx.pushData({ title: "hello" });
    await ctx.pushData({ title: "world" });
  });
  crawler.useRouter(router);
  // Simulate a minimal runner so CrawlContextImpl can access logger
  crawler._runner = { logger: { info() {}, warn() {}, error() {}, debug() {} } };
  // Simulate the internal _processPage call
  const result = await crawler._processPage(
    { url: "https://example.com/", method: "GET", depth: 0, userData: {} },
    { status: 200, body: "<html></html>" },
    null
  );
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
  assert.equal(result[0].title, "hello");
  assert.equal(result[1].title, "world");
  assert.equal(result[0]._url, "https://example.com/");
});

test("OmniCrawler _processPage exposes route params and labels", async () => {
  const crawler = new OmniCrawler({ name: "route-meta-test" });
  crawler.addSeedUrls(["https://example.com/products/42"]);
  const router = new Router();
  router.addHandler("/products/:id", async (ctx) => {
    assert.equal(ctx.label, "product");
    assert.equal(ctx.request.label, "product");
    assert.equal(ctx.params.id, "42");
    assert.equal(ctx.request.params.id, "42");
    await ctx.pushData({ id: ctx.params.id, routeLabel: ctx.label });
  }, { label: "product" });
  crawler.useRouter(router);
  crawler._runner = { logger: { info() {}, warn() {}, error() {}, debug() {} } };

  const result = await crawler._processPage(
    { url: "https://example.com/products/42", method: "GET", depth: 0, userData: {}, metadata: {} },
    { status: 200, body: "<html></html>" },
    null
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].id, "42");
  assert.equal(result[0].routeLabel, "product");
});

test("OmniCrawler snapshot exposes runner metrics and pushed item count", () => {
  const crawler = new OmniCrawler({ name: "snapshot-test" });
  crawler._running = true;
  crawler._itemCount = 3;
  crawler._runner = {
    getMetrics() {
      return {
        pagesFetched: 5,
        requestsFailed: 1,
        requestsRetried: 2,
        queuedCount: 8,
      };
    },
  };

  const snapshot = crawler.snapshot();
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.name, "snapshot-test");
  assert.equal(snapshot.itemsPushed, 3);
  assert.equal(snapshot.pagesFetched, 5);
  assert.equal(snapshot.requestsFailed, 1);
  assert.equal(snapshot.requestsRetried, 2);
  assert.equal(snapshot.queuedCount, 8);
  assert.equal(snapshot.jobId, null);
  assert.equal(snapshot.datasetId, null);
});
