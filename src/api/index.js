/**
 * OmniCrawl Programmatic API
 *
 * This module provides the modern, chainable API for OmniCrawl.
 * It complements the existing JSON workflow-driven API.
 *
 * @example
 * import { OmniCrawler, Router } from 'omnicrawl';
 *
 * const router = new Router()
 *   .addHandler('/products/*', async (ctx) => {
 *     await ctx.pushData({ url: ctx.finalUrl, title: ctx.body.match(/<h1>(.*?)<\/h1>/)?.[1] });
 *   }, { label: 'product' })
 *   .addDefaultHandler(async (ctx) => {
 *     await ctx.enqueueLinks(ctx.extracted?.links ?? []);
 *   });
 *
 * const crawler = new OmniCrawler({ name: 'shop-crawler' })
 *   .addSeedUrls('https://shop.example.com')
 *   .setMode('browser')
 *   .useRouter(router)
 *   .gracefulShutdown();
 *
 * const summary = await crawler.run();
 */

export { OmniCrawler } from './omnicrawler.js';
export { Router } from './router.js';
export { CrawlContextImpl as CrawlContext } from './crawl-context.js';
export { ItemPipeline } from './item-pipeline.js';
export { GracefulShutdown } from './graceful-shutdown.js';
export { MfaHandler, solveLoginMfa } from './mfa-handler.js';
export { createAuthHandler } from '../middleware/auth-handler.js';
export { buildWorkflowFromTemplate, buildWorkflowFromUniversalTarget, buildPreviewWorkflow, getWorkflowTemplateCatalog } from '../runtime/workflow-templates.js';
export {
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
  UniversalCrawler,
  PuppeteerCrawler,
  PuppeteerCoreCrawler,
  PlaywrightCrawler,
  PlaywrightCoreCrawler,
  PatchrightCrawler,
  detectUniversalSourceType,
  inferUniversalSourceProfile,
} from './crawler-presets.js';
