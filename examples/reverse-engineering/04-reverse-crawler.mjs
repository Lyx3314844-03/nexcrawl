/**
 * Example 4: Reverse Engineering Crawler
 * 
 * Demonstrates WAF bypass, CAPTCHA solving, and JS deobfuscation.
 * 
 * Usage: node examples/reverse-engineering/04-reverse-crawler.mjs
 */

import { OmniCrawler, Router } from 'omnicrawl';

const router = new Router();

// Handle Cloudflare-protected pages
router.on('https://protected.example.com/data/*', async (ctx) => {
  // ctx.reverse is available when useStealth() is enabled
  const deobfuscated = ctx.reverse.deobfuscate(ctx.$('script').html());
  
  const data = {
    title: ctx.$('h1').text().trim(),
    apiEndpoints: ctx.reverse.extractApiEndpoints(deobfuscated),
    signatures: ctx.reverse.inferSignatures(deobfuscated),
    url: ctx.request.url,
  };

  await ctx.addItem(data);
});

// Handle pages with obfuscated JavaScript
router.on('https://obfuscated.example.com/app/*', async (ctx) => {
  const scripts = ctx.$('script').map((_, el) => ctx.$(el).html()).get();
  
  const analysis = ctx.reverse.analyzeBundle(scripts, {
    deobfuscate: true,
    extractApis: true,
    traceFunctions: true,
  });

  await ctx.addItem({
    url: ctx.request.url,
    apiCount: analysis.apis.length,
    signatures: analysis.signatures,
    webpackModules: analysis.webpack?.modules?.length ?? 0,
  });
});

const crawler = new OmniCrawler()
  .useBrowserCrawler({ headless: true })
  .useRouter(router)
  .useStealth()  // Enables reverse engineering capabilities
  .useRateLimits({ requestsPerSecond: 0.5, burstSize: 2 })  // Slow for protected sites
  .onComplete(async ({ dataset }) => {
    await dataset.export('json', { path: './output/reverse-results.json' });
  });

const summary = await crawler.run();
console.log(`Done: ${summary.requestsTotal} pages, ${summary.itemsAdded} items extracted`);
