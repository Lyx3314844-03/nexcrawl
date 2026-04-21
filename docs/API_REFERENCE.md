# OmniCrawl API Reference

> Version 1.1.0 | Current surface summary

## Public Entry Points

```javascript
import {
  OmniCrawler,
  Router,
  ItemPipeline,
  GracefulShutdown,
  HttpCrawler,
  BrowserCrawler,
  HybridCrawler,
  GraphQLCrawler,
  WebSocketCrawler,
} from 'omnicrawl';
```

## OmniCrawler

`OmniCrawler` is the main fluent builder.

### Constructor

```javascript
const crawler = new OmniCrawler({
  name: 'demo',
  mode: 'http',
  concurrency: 5,
  timeoutMs: 30000,
});
```

### Core methods

| Method | Purpose |
|---|---|
| `addSeedUrls(urls)` / `addRequests(requests)` | Add seed requests |
| `setMode(mode)` | `http`, `cheerio`, `browser`, `hybrid` |
| `setConcurrency(n)` | Set workflow concurrency |
| `setMaxDepth(n)` | Set discovery depth |
| `setTimeout(ms)` | Set request timeout |
| `setHeaders(headers)` | Merge request headers |
| `setProjectRoot(dir)` | Override project root |
| `useRouter(router)` | Attach a `Router` |
| `useItemPipeline(pipeline)` | Attach an `ItemPipeline` |
| `useMiddleware(middleware)` | Register route/runtime middleware hooks |
| `usePlugin(plugin, options?)` | Register programmatic runtime plugin |
| `useProxy(proxy)` | Set a single proxy |
| `useProxyPool(config)` | Configure workflow proxy pool |
| `useRateLimiter(config)` | Configure workflow rate limiter |
| `useExport(config)` | Configure export |
| `setBrowserOptions(config)` | Configure browser runtime |
| `setSessionOptions(config)` | Configure session behavior |
| `setRetryOptions(config)` | Configure retry behavior |
| `setAutoscaleOptions(config)` | Configure autoscaling |
| `setRequestQueueOptions(config)` | Configure queue/frontier |
| `setDiscovery(config)` | Configure discovery |
| `setExtractRules(rules)` | Override extract rules |
| `setCrawlPolicy(config)` | Configure crawl policy |
| `setIdentity(config)` | Configure identity consistency |
| `setSigner(config)` | Configure signer runtime |
| `setReverseRuntime(config)` | Configure reverse runtime |
| `useStealth(options?)` | Enable stealth identity settings |
| `useCloudflareSolver(options?)` | Enable Cloudflare challenge handling |
| `useBehaviorSimulation(options?)` | Enable behavior simulation |
| `useCaptchaSolver(provider, apiKey, options?)` | Configure CAPTCHA solver |
| `useAppWebView(appType, options?)` | Configure WebView emulation |
| `useReverseAnalysis(options?)` | Enable reverse analysis |
| `useTlsProfile(profileName)` | Set TLS profile |
| `useH2Profile(profile)` | Set HTTP/2 profile |
| `useReverse(config)` | Merge reverse-engine config |
| `onReady(fn)` / `onIdle(fn)` / `onComplete(fn)` / `onError(fn)` / `onFailedRequest(fn)` | Lifecycle callbacks |
| `gracefulShutdown(options?)` | Attach shutdown manager |
| `run()` | Validate, run, return summary |
| `snapshot()` | Return runtime snapshot |

### Example

```javascript
const router = new Router().addDefaultHandler(async (ctx) => {
  await ctx.pushData({
    url: ctx.finalUrl,
    title: ctx.body.match(/<title>([^<]+)<\/title>/i)?.[1] ?? null,
  });
});

const crawler = new OmniCrawler({ name: 'demo' })
  .addSeedUrls('https://example.com')
  .setMode('http')
  .useRouter(router);

const summary = await crawler.run();
```

## Router

`Router` maps URL patterns to handlers.

### Methods

| Method | Purpose |
|---|---|
| `addHandler(pattern, handler, options?)` | Register handler for glob / regexp / `:param` pattern |
| `addDefaultHandler(handler)` | Fallback handler |
| `getHandlerByLabel(label)` | Resolve labeled handler |
| `resolve(url, label?)` | Resolve URL to handler |
| `labels()` | List registered labels |
| `hasLabel(label)` | Check label existence |

### Example

```javascript
const router = new Router()
  .addHandler('/products/:id', async (ctx) => {
    await ctx.pushData({
      id: ctx.request.params.id,
      url: ctx.finalUrl,
    });
  }, { label: 'product' })
  .addDefaultHandler(async (ctx) => {
    await ctx.enqueueExtractedLinks('links');
  });
```

## CrawlContext

Route handlers receive a `CrawlContext`.

### Main properties

| Property | Description |
|---|---|
| `request` | Current request metadata |
| `response` | Fetch response |
| `extracted` | Extracted values for this page |
| `page` | Browser page in browser mode |
| `body` | Response body shorthand when available |
| `finalUrl` | Final resolved URL |
| `log` | Request-scoped logger |

### Main methods

| Method | Purpose |
|---|---|
| `enqueue(urlOrRequest, options?)` | Enqueue one request |
| `enqueueLinks(urls, options?)` | Enqueue many requests |
| `enqueueExtractedLinks(source?, options?)` | Enqueue links from extracted output |
| `pushData(item)` | Buffer dataset item |
| `drainItems(pipeline?)` | Drain buffered items through optional pipeline |
| `inputValue(key)` | Read key-value record |
| `setValue(key, value)` | Write key-value record |
| `snapshot()` | Runtime metrics snapshot |
| `reverseEngine` | Reverse engine instance when configured |
| `runReverseOperation(operation, payload?)` | Execute a named reverse operation |
| `generateHookCode(options?)` | Generate runtime hook code |

### Reverse-analysis helpers

`CrawlContext` also exposes helper methods such as:

- `analyzeJS()`
- `analyzeCrypto()`
- `analyzeWebpack()`
- `locateSignature()`
- `summarizeWorkflow()`
- `simulateHumanBehavior()`

These require reverse capabilities to be configured.

## ItemPipeline

`ItemPipeline` is a step-based transformer.

### Methods

| Method | Purpose |
|---|---|
| `addStep(step)` | Add async/sync processing step |
| `process(item, ctx)` | Process one item |
| `stats()` | Pipeline counters |
| `steps()` | Copy of registered steps |
| `reset()` | Reset counters |

### Example

```javascript
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
```

## GracefulShutdown

Zero-data-loss shutdown manager.

### Constructor options

| Option | Default | Purpose |
|---|---:|---|
| `timeoutMs` | `15000` | Max wait before forced exit |
| `install` | `true` | Auto-install shared signal handlers |
| `persistOnShutdown` | `true` | Run persistence callbacks first |
| `onShutdown` | `null` | Initial cleanup callback |

### Methods

| Method | Purpose |
|---|---|
| `register(callback)` | Register cleanup callback |
| `registerJobPersistence(callback)` | Register persistence callback |
| `install()` | Install shared signal handlers |
| `uninstall()` | Remove current instance from shared handler set |
| `shutdown(reason?)` | Run persistence + cleanup |

## Rate Limiting

### `RateLimiter`

Request-facing token bucket middleware from `src/middleware/rate-limiter.js`.

### `DomainRateLimiter`

Per-domain crawl limiter used by the runtime.

Key methods:

- `acquire(target)`
- `release(target)`
- `report(target, outcome)`

## Observability

Current observability is an **in-process tracing/metrics surface**.

It provides:

- `setupObservability(config)`
- `getTracer()`
- `getMetrics()`
- `getPromRegistry()`
- `getPromMetrics()`
- `summarizeObservability()`
- `shutdownObservability()`

Important note:

- `getPromRegistry()` returns the built-in registry wrapper used by the current process
- `getPromMetrics()` returns Prometheus-format text from the current built-in registry
- the current implementation should still be treated as a lightweight built-in observability layer, not a full external OTEL / Prometheus deployment story

## Runtime Integrations

The runtime can now expose optional integration health and dry-run probe surfaces.

### HTTP API

- `GET /runtime/integrations`
- `POST /runtime/integrations/probe`

### Programmatic exports

- `inspectOptionalIntegrations()`
- `probeIntegration()`
- `probeIntegrations()`

Supported integration ids currently include:

- `redis`
- `postgres`
- `mysql`
- `mongodb`
- `smtp`
- `s3`
- `gcs`
- `azure`

These surfaces are intended for discovery, configuration validation, and operator diagnostics.  
They are not a replacement for full cloud SaaS orchestration or managed secret distribution.

## Logger

Two logging surfaces exist:

- `createLogger()` in `src/core/logger.js` for runtime internals
- `getLogger()` / `Logger` in `src/utils/logger.js` for exported application-facing logging

### Example

```javascript
import { getLogger } from 'omnicrawl';

const log = getLogger('my-module');
log.info('started', { url: 'https://example.com' });
```

Core runtime logging now:

- normalizes string logger names
- reuses shared pino roots
- redacts sensitive fields before output

## Reverse Engineering

Selected exports include:

- `detectWaf`
- `getWafBypassConfig`
- `BrowserSandbox`
- `runInBrowserSandbox`
- `inferSignatureParams`
- `inferAllSignatureFunctions`
- `fullDeobfuscate`
- `optimizeWithAnalysis`
- `applyFingerprintProtection`
- `buildFingerprintProtection`

These capabilities are powerful but not all of them should be treated as equally mature production surfaces.

## Storage / Runtime Exports

Selected runtime exports include:

- `DatasetStore`
- `KeyValueStore`
- `RequestQueue`
- `SessionStore`
- `SessionPool`
- `ProxyPool`
- `JobStore`
- `Sqlite*` stores
- `createRedisControlPlane`
- `DistributedWorkerService`

## Preset Crawlers

Available presets:

- `HttpCrawler`
- `CheerioCrawler`
- `BrowserCrawler`
- `HybridCrawler`
- `JSDOMCrawler`
- `ApiJsonCrawler`
- `FeedCrawler`
- `SitemapCrawler`
- `GraphQLCrawler`
- `WebSocketCrawler`
- `PuppeteerCrawler`
- `PuppeteerCoreCrawler`
- `PlaywrightCrawler`
- `PlaywrightCoreCrawler`
- `PatchrightCrawler`

Notes:

- `FeedCrawler` / `SitemapCrawler` are no longer only XML field extract presets; they can discover downstream URLs and continue through the unified job pipeline.
- `WebSocketCrawler` supports both helper-style `connect()` / `subscribe()` usage and `run()`-driven job execution.
- `GraphQLCrawler` combines endpoint detection, query execution, introspection, and pagination helpers around the same preset surface.

## Runtime Surfaces

In addition to importable crawlers, OmniCrawl also exposes runtime/control-plane surfaces:

- CLI:
  - `omnicrawl capabilities`
  - `omnicrawl integrations`
  - `omnicrawl integration-probe`
- HTTP API:
  - `GET /capabilities`
  - `GET /reverse/capabilities`
  - `GET /runtime/integrations`
  - `POST /runtime/integrations/probe`
  - `GET /jobs/:jobId/replay-recipe`
  - `GET /jobs/:jobId/replay-workflow-template`
  - `POST /jobs/:jobId/replay-workflow/run`
- Programmatic run stores:
  - `crawler.getDatasetInfo()`
  - `crawler.listItems()`
  - `crawler.getKeyValueInfo()`
  - `crawler.listRecords()`
  - `crawler.getValue(key)`
  - `crawler.setValue(key, value)`
