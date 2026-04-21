# OmniCrawl Quick Start

> A current, runnable getting-started guide

## Prerequisites

- Node.js >= 20
- npm >= 9
- Optional: Redis for distributed mode
- Optional: Chrome / Chromium compatible browser runtime

## Install

Install from npm:

### Windows

```powershell
npm install omnicrawl
```

### macOS

```bash
npm install omnicrawl
```

### Linux

```bash
npm install omnicrawl
```

Install dependencies in this repository:

```bash
npm install
```

## 1. Minimal HTTP Crawl

```javascript
import { HttpCrawler, Router } from 'omnicrawl';

const router = new Router().addDefaultHandler(async (ctx) => {
  await ctx.pushData({
    url: ctx.finalUrl,
    title: ctx.body.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null,
  });
});

const crawler = new HttpCrawler({ name: 'quick-http' })
  .addSeedUrls('https://example.com')
  .useRouter(router);

const summary = await crawler.run();
console.log(summary.status, summary.pagesFetched);
```

Run it:

```bash
node my-crawler.mjs
```

## 2. Browser Crawl

```javascript
import { BrowserCrawler, Router } from 'omnicrawl';

const router = new Router().addDefaultHandler(async (ctx) => {
  const data = await ctx.page.evaluate(() => ({
    title: document.title,
    content: document.body.innerText,
  }));

  await ctx.pushData(data);
});

const crawler = new BrowserCrawler({ name: 'quick-browser' })
  .addSeedUrls('https://example.com')
  .useStealth({ locale: 'zh-CN' })
  .useBehaviorSimulation({
    mouseMovement: true,
    scrolling: true,
  })
  .useRouter(router);

await crawler.run();
```

## 3. Use ItemPipeline

```javascript
import { HttpCrawler, ItemPipeline, Router } from 'omnicrawl';

const pipeline = new ItemPipeline()
  .addStep(async (item) => {
    if (!item.title) {
      throw new Error('title is required');
    }
    return {
      ...item,
      title: item.title.trim(),
    };
  });

const router = new Router().addDefaultHandler(async (ctx) => {
  await ctx.pushData({
    url: ctx.finalUrl,
    title: ctx.body.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null,
  });
});

const crawler = new HttpCrawler({ name: 'quick-pipeline' })
  .addSeedUrls('https://example.com')
  .useRouter(router)
  .useItemPipeline(pipeline);

await crawler.run();
```

## 4. Distributed Mode

```javascript
import { createRedisControlPlane, DistributedWorkerService } from 'omnicrawl';

const controlPlane = createRedisControlPlane({
  redis: {
    host: '127.0.0.1',
    port: 6379,
  },
});

const worker = new DistributedWorkerService({
  controlPlane,
});

await worker.start();
```

## 5. Protocol Presets

```javascript
import { FeedCrawler, SitemapCrawler, WebSocketCrawler, GraphQLCrawler } from 'omnicrawl';

await new FeedCrawler({ name: 'feed-quick' })
  .addSeedUrls('https://example.com/feed.xml')
  .run();

await new SitemapCrawler({ name: 'sitemap-quick' })
  .addSeedUrls('https://example.com/sitemap.xml')
  .run();

await new WebSocketCrawler({ name: 'ws-quick' })
  .setWebSocketOptions({
    sendMessage: { subscribe: 'updates' },
    collectMs: 2000,
  })
  .addSeedUrls('wss://example.com/socket')
  .run();

const gql = new GraphQLCrawler();
const schema = await gql.introspect('https://example.com/graphql');
console.log(schema?.queryType);
```

说明：

- `FeedCrawler` / `SitemapCrawler` 现在不是只提取 XML 字段，而是会把发现到的 URL 继续推进统一队列。
- `WebSocketCrawler.run()` 也会走统一 job pipeline，不再只是独立 helper。
- `GraphQLCrawler` 既可单独执行 query / introspection，也可作为 API 预设的一部分参与统一运行链路。

## 6. Runtime Surfaces

CLI:

```bash
omnicrawl capabilities
omnicrawl integrations
omnicrawl integration-probe redis --config-json "{\"url\":\"redis://localhost:6379\"}"
```

HTTP API:

- `GET /capabilities`
- `GET /reverse/capabilities`
- `GET /runtime/integrations`
- `POST /runtime/integrations/probe`
- `GET /jobs/:jobId/replay-recipe`
- `GET /jobs/:jobId/replay-workflow-template`
- `POST /jobs/:jobId/replay-workflow/run`

这些面说明 OmniCrawl 不只是“跑一个爬虫脚本”，而是已经带有 control plane、replay、integration probe、reverse diagnostics 这些运行时能力。

## 7. Global Config

Currently the most important globally wired settings are:

- `performance.concurrency`
- `performance.timeout`
- `security.validation.maxCodeLength`
- `security.validation.allowDangerousPatterns`
- `security.validation.allowPrivateIPs`

Example:

```javascript
import { setGlobalConfig } from 'omnicrawl';

setGlobalConfig({
  performance: {
    concurrency: 8,
    timeout: 45000,
  },
  security: {
    validation: {
      allowPrivateIPs: false,
      maxCodeLength: 200000,
    },
  },
});
```

## 8. Testing

```bash
# Full test suite
npm test

# Reverse-focused tests
npm run test:reverse

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```

## 9. Observability

Current observability is a lightweight built-in runtime surface.

Useful endpoints:

- `/metrics`
- `/runtime/metrics`

Useful APIs:

- `setupObservability()`
- `summarizeObservability()`
- `getPromMetrics()`

## Optional Integrations

You can inspect optional service integrations at runtime:

```bash
omnicrawl integrations
omnicrawl integration-probe redis --config-json "{\"url\":\"redis://localhost:6379\"}"
```

HTTP API:

- `GET /runtime/integrations`
- `POST /runtime/integrations/probe`

If you need a full external OTEL / Prometheus deployment story, treat that as follow-up integration work rather than something already fully abstracted away.

## Next Reading

- [API_REFERENCE.md](./API_REFERENCE.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
- [CONFIG.md](../CONFIG.md)
- [EXAMPLES.md](../EXAMPLES.md)
