/**
 * Example 3: Distributed Crawler with Redis Rate Limiting
 * 
 * Run multiple instances — Redis coordinates rate limits globally.
 * 
 * Usage: REDIS_HOST=127.0.0.1 node examples/advanced/03-distributed-crawler.mjs
 */

import { OmniCrawler, Router } from 'omnicrawl';

const router = new Router();

router.on('https://example.com/page/*', async (ctx) => {
  const title = ctx.$('h1').text().trim();
  const body = ctx.$('.content').text().trim();
  await ctx.addItem({ title, body, url: ctx.request.url });
});

router.onDefault(async (ctx) => {
  const links = ctx.$('a[href]').map((_, el) => ctx.$(el).attr('href')).get();
  await ctx.enqueue(links);
});

const crawler = new OmniCrawler()
  .useCheerioCrawler({ maxConcurrency: 20 })
  .useRouter(router)
  .useRateLimits({
    requestsPerSecond: 5,
    burstSize: 10,
    maxConcurrent: 3,
    redis: {
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: parseInt(process.env.REDIS_PORT ?? '6379'),
      password: process.env.REDIS_PASSWORD,
    },
  })
  .useJobPersistence({ storagePath: './data' })
  .useObservability({
    otelEnabled: true,
    prometheusEnabled: true,
    prometheusPort: parseInt(process.env.PROMETHEUS_PORT ?? '9464'),
  })
  .onComplete(async ({ dataset }) => {
    await dataset.export('jsonl', { path: './output/results.jsonl' });
  });

const summary = await crawler.run();
console.log(`Done: ${summary.requestsTotal} requests in ${summary.durationMs}ms`);
