/**
 * Example 5: Sitemap-based Crawler
 * 
 * Reads sitemap.xml for URL discovery, then crawls each page.
 * 
 * Usage: node examples/advanced/05-sitemap-crawler.mjs
 */

import { OmniCrawler, Router } from 'omnicrawl';

const router = new Router();

router.on('https://shop.example.com/product/*', async (ctx) => {
  const item = {
    name: ctx.$('h1.product-title').text().trim(),
    price: ctx.$('.price').text().trim(),
    sku: ctx.$('[data-sku]').attr('data-sku'),
    category: ctx.$('.breadcrumb li:nth-child(2)').text().trim(),
    inStock: ctx.$('.stock-status').text().includes('In Stock'),
    url: ctx.request.url,
  };

  await ctx.addItem(item);
});

const crawler = new OmniCrawler()
  .useCheerioCrawler({ maxConcurrency: 10 })
  .useRouter(router)
  .useSitemaps(['https://shop.example.com/sitemap.xml'])
  .useRateLimits({ requestsPerSecond: 5, burstSize: 15 })
  .onComplete(async ({ dataset }) => {
    await dataset.export('csv', { path: './output/products.csv' });
    console.log('Products exported to CSV!');
  });

const summary = await crawler.run();
console.log(`Crawled ${summary.requestsTotal} product pages in ${summary.durationMs}ms`);
