/**
 * Example 1: Basic Cheerio Crawler
 * 
 * Crawls a website using HTTP + Cheerio (no browser needed).
 * Extracts titles and follows links.
 * 
 * Usage: node examples/basic/01-cheerio-crawler.mjs
 */

import { OmniCrawler, Router } from 'omnicrawl';

const router = new Router();

// Handle article pages
router.on('https://news.example.com/article/*', async (ctx) => {
  const title = ctx.$('h1').text().trim();
  const author = ctx.$('.author').text().trim();
  const date = ctx.$('time').attr('datetime');
  const content = ctx.$('.article-body').text().trim();

  await ctx.addItem({ title, author, date, content, url: ctx.request.url });
});

// Handle listing pages — follow pagination
router.on('https://news.example.com/', async (ctx) => {
  const articleLinks = ctx.$('a[href*="/article/"]')
    .map((_, el) => ctx.$(el).attr('href'))
    .get();

  await ctx.enqueue(articleLinks);

  // Follow pagination
  const next = ctx.$('a.next').attr('href');
  if (next) await ctx.enqueue([next]);
});

const crawler = new OmniCrawler()
  .useCheerioCrawler({ maxConcurrency: 5 })
  .useRouter(router)
  .useRateLimits({ requestsPerSecond: 2, burstSize: 5 })
  .onComplete(async ({ dataset }) => {
    await dataset.export('json', { path: './output/articles.json' });
    console.log('Export completed!');
  });

const summary = await crawler.run();
console.log(`Done: ${summary.requestsTotal} requests in ${summary.durationMs}ms`);
