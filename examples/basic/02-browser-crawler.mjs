/**
 * Example 2: Browser Crawler (SPA/JS-rendered pages)
 * 
 * Usage: node examples/basic/02-browser-crawler.mjs
 */

import { OmniCrawler, Router } from 'omnicrawl';

const router = new Router();

router.on('https://spa.example.com/product/*', async (ctx) => {
  await ctx.page.waitForSelector('.product-info');
  
  const data = await ctx.page.evaluate(() => ({
    name: document.querySelector('.product-name')?.textContent?.trim(),
    price: document.querySelector('.price')?.textContent?.trim(),
    availability: document.querySelector('.stock')?.textContent?.trim(),
    images: [...document.querySelectorAll('.gallery img')].map(i => i.src),
  }));
  
  await ctx.addItem({ ...data, url: ctx.request.url });
});

router.on('https://spa.example.com/', async (ctx) => {
  // Scroll to load all products (infinite scroll)
  await ctx.page.evaluate(async () => {
    let lastHeight = document.body.scrollHeight;
    while (true) {
      window.scrollBy(0, window.innerHeight);
      await new Promise(r => setTimeout(r, 1000));
      if (document.body.scrollHeight === lastHeight) break;
      lastHeight = document.body.scrollHeight;
    }
  });
  
  const productLinks = await ctx.page.evaluate(() =>
    [...document.querySelectorAll('a[href*="/product/"]')].map(a => a.href)
  );
  await ctx.enqueue(productLinks);
});

const crawler = new OmniCrawler()
  .useBrowserCrawler({ headless: true, maxOpenPagesPerBrowser: 5 })
  .useRouter(router)
  .useStealth()
  .useRateLimits({ requestsPerSecond: 1, burstSize: 3 })
  .onComplete(async ({ dataset }) => {
    await dataset.export('json', { path: './output/products.json' });
  });

const summary = await crawler.run();
console.log(`Done: ${summary.requestsTotal} pages in ${summary.durationMs}ms`);
