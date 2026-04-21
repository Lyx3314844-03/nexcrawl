/**
 * Example 6: Full Observability Crawler
 * 
 * Demonstrates OpenTelemetry tracing + Prometheus metrics + structured logging.
 * 
 * Usage: OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node examples/advanced/06-observability-crawler.mjs
 */

import { OmniCrawler, Router } from 'omnicrawl';

const router = new Router();

router.on('https://api.example.com/v1/*', async (ctx) => {
  const json = ctx.response.body;
  await ctx.addItem({
    id: json.id,
    name: json.name,
    status: json.status,
    url: ctx.request.url,
  });
});

router.onDefault(async (ctx) => {
  const links = ctx.$('a[href]').map((_, el) => ctx.$(el).attr('href')).get();
  await ctx.enqueue(links);
});

const crawler = new OmniCrawler()
  .useCheerioCrawler({ maxConcurrency: 10 })
  .useRouter(router)
  .useRateLimits({ requestsPerSecond: 3, burstSize: 10 })
  .useObservability({
    otelEnabled: true,
    otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
    prometheusEnabled: true,
    prometheusPort: parseInt(process.env.PROMETHEUS_PORT ?? '9464'),
  })
  .onComplete(async ({ dataset }) => {
    await dataset.export('jsonl', { path: './output/api-data.jsonl' });
  });

const summary = await crawler.run();
console.log(`Done: ${summary.requestsTotal} requests, ${summary.errorsTotal} errors in ${summary.durationMs}ms`);
console.log(`Prometheus metrics available at http://localhost:${process.env.PROMETHEUS_PORT ?? 9464}/metrics`);
