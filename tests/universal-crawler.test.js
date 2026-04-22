import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
  UniversalCrawler,
  detectUniversalSourceType,
  inferUniversalSourceProfile,
} from '../src/api/crawler-presets.js';
import { runExtractors } from '../src/extractors/extractor-engine.js';
import { TorCrawler } from '../src/runtime/tor-crawler.js';

test('detectUniversalSourceType recognizes common source kinds', () => {
  assert.equal(detectUniversalSourceType({
    url: 'https://example.com/sitemap.xml',
    contentType: 'application/xml',
    body: '<urlset><url><loc>https://example.com/a</loc></url></urlset>',
  }), 'sitemap');

  assert.equal(detectUniversalSourceType({
    url: 'https://example.com/feed.xml',
    contentType: 'application/rss+xml',
    body: '<rss><channel></channel></rss>',
  }), 'feed');

  assert.equal(detectUniversalSourceType({
    url: 'https://example.com/api/items',
    contentType: 'application/json',
    body: '{"items":[1,2,3]}',
  }), 'json');

  assert.equal(detectUniversalSourceType({
    url: 'wss://example.com/socket',
  }), 'websocket');
});

test('inferUniversalSourceProfile surfaces embedded GraphQL endpoints from html', () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://example.com/app',
    contentType: 'text/html; charset=utf-8',
    body: `
      <html>
        <body>
          <script>
            fetch('/graphql', { method: 'POST' });
          </script>
        </body>
      </html>
    `,
  });

  assert.equal(profile.kind, 'html');
  assert.equal(profile.pageKind, 'generic');
  assert.equal(profile.mode, 'hybrid');
  assert.equal(profile.recommendedPreset, 'UniversalCrawler');
  assert.deepEqual(profile.graphqlEndpoints, ['https://example.com/graphql']);
  assert.equal(profile.supportedByUniversal, true);
  assert.ok(profile.frontend.frameworks.length === 0);
  assert.ok(profile.extractRules.some((rule) => rule.name === 'title'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'jsonLd'));
});

test('inferUniversalSourceProfile detects hydration data and app shell pages, upgrading to browser mode when needed', () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://shop.example.com/app',
    contentType: 'text/html; charset=utf-8',
    body: `
      <html>
        <body>
          <div id="__next"></div>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[{"id":1}]}}}</script>
          <script src="/_next/static/chunks/main.js"></script>
          <script>window.__APOLLO_STATE__ = {"ROOT_QUERY":{"viewer":{"id":"u1"}}};</script>
        </body>
      </html>
    `,
  });

  assert.equal(profile.kind, 'html');
  assert.equal(profile.mode, 'browser');
  assert.ok(profile.frontend.frameworks.includes('nextjs'));
  assert.ok(profile.frontend.frameworks.includes('apollo'));
  assert.ok(profile.frontend.hydrationSources.includes('__NEXT_DATA__'));
  assert.ok(profile.frontend.hydrationSources.includes('__APOLLO_STATE__'));
  assert.equal(profile.frontend.appShellLikely, true);
  assert.equal(profile.strategyHints.browserShellLikely, true);
  assert.equal(profile.strategyHints.lane, 'browser-shell');
  assert.ok(profile.extractRules.some((rule) => rule.name === 'frontendSignals'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'hydrationData'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'networkPayloads'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'networkPrimaryData'));
  assert.equal(profile.extractRules.find((rule) => rule.name === 'networkPayloads').selection, 'payload');
  assert.equal(profile.extractRules.find((rule) => rule.name === 'networkPrimaryData').selection, 'primary-data');
});

test('inferUniversalSourceProfile emits signer/native/anti-bot strategy hints for hard targets', () => {
  const antiBotProfile = inferUniversalSourceProfile({
    url: 'https://example.com/protected',
    contentType: 'text/html',
    body: `
      <html>
        <body>
          <div>Checking your browser before accessing</div>
          <div class="cf-turnstile" data-sitekey="demo"></div>
          <script>window.__cf_chl_opt = {};</script>
        </body>
      </html>
    `,
    headers: {
      server: 'cloudflare',
      'cf-ray': 'abc123',
    },
  });
  const signerProfile = inferUniversalSourceProfile({
    url: 'https://api.example.com/app',
    contentType: 'text/html',
    body: `
      <html>
        <body>
          <script>
            async function signRequest(payload) {
              return CryptoJS.HmacSHA256(payload, 'secret').toString();
            }
          </script>
        </body>
      </html>
    `,
  });
  const nativeProfile = inferUniversalSourceProfile({
    url: 'https://m.example.com/app',
    contentType: 'text/html',
    body: `
      <html>
        <body>
          <script>
            window.WeixinJSBridge = {};
            const sslPinning = true;
            const frida = 'required';
          </script>
        </body>
      </html>
    `,
  });

  assert.equal(antiBotProfile.strategyHints.antiBotLikely, true);
  assert.equal(antiBotProfile.strategyHints.lane, 'anti-bot');
  assert.ok(antiBotProfile.strategyHints.recommendedModules.includes('cloudflare-solver'));

  assert.equal(signerProfile.strategyHints.signerLikely, true);
  assert.equal(signerProfile.strategyHints.lane, 'signer');
  assert.ok(signerProfile.strategyHints.recommendedModules.includes('reverse-signer-runtime'));

  assert.equal(nativeProfile.strategyHints.nativeAppLikely, true);
  assert.equal(nativeProfile.strategyHints.appWebViewLikely, true);
  assert.equal(nativeProfile.strategyHints.lane, 'native-app');
  assert.ok(nativeProfile.strategyHints.recommendedModules.includes('mobile-crawler'));
  assert.ok(nativeProfile.strategyHints.recommendedModules.includes('app-webview'));
});

test('UniversalCrawler configureSource auto-specializes browser-shell, anti-bot, signer, and app-webview lanes', () => {
  const antiBotProfile = inferUniversalSourceProfile({
    url: 'https://example.com/protected',
    contentType: 'text/html',
    body: `
      <html>
        <body>
          <div>Checking your browser before accessing</div>
          <div class="cf-turnstile" data-sitekey="demo"></div>
          <script>window.__cf_chl_opt = {};</script>
        </body>
      </html>
    `,
    headers: {
      server: 'cloudflare',
      'cf-ray': 'abc123',
    },
  });
  const signerProfile = inferUniversalSourceProfile({
    url: 'https://api.example.com/app',
    contentType: 'text/html',
    body: `
      <html><body><script>async function signRequest(payload){ return CryptoJS.HmacSHA256(payload, 'secret').toString(); }</script></body></html>
    `,
  });
  const webViewProfile = inferUniversalSourceProfile({
    url: 'https://m.example.com/app',
    contentType: 'text/html',
    body: `
      <html><body><script>window.WeixinJSBridge = {}; const sslPinning = true;</script></body></html>
    `,
  });

  const antiBotCrawler = new UniversalCrawler({ name: 'anti-bot-auto' }).addSeedUrls('https://example.com');
  antiBotCrawler.configureSource(antiBotProfile, {
    captchaProvider: 'capsolver',
    captchaApiKey: 'demo-key',
  });
  const antiBotWorkflow = antiBotCrawler._buildWorkflow();

  assert.equal(antiBotWorkflow.mode, 'browser');
  assert.equal(antiBotCrawler._reverseConfig.cloudflare.enabled, true);
  assert.equal(antiBotCrawler._reverseConfig.behaviorSim.enabled, true);
  assert.equal(antiBotCrawler._reverseConfig.captcha.provider, 'capsolver');
  assert.equal(antiBotWorkflow.browser.debug.captureNetwork, true);

  const signerCrawler = new UniversalCrawler({ name: 'signer-auto' }).addSeedUrls('https://example.com');
  signerCrawler.configureSource(signerProfile);
  const signerWorkflow = signerCrawler._buildWorkflow();

  assert.equal(signerCrawler._signerConfig.enabled, true);
  assert.equal(signerCrawler._reverseRuntimeConfig.autoReverseAnalysis, true);
  assert.equal(signerWorkflow.signer.enabled, true);

  const webViewCrawler = new UniversalCrawler({ name: 'webview-auto' }).addSeedUrls('https://example.com');
  webViewCrawler.configureSource(webViewProfile);
  const webViewWorkflow = webViewCrawler._buildWorkflow();

  assert.equal(webViewWorkflow.mode, 'browser');
  assert.equal(webViewCrawler._reverseConfig.appWebView.type, 'wechat');
  assert.equal(webViewWorkflow.reverse.app.platform, 'webview');
  assert.equal(webViewWorkflow.identity.bundleId, 'com.tencent.mm');
});

test('inferUniversalSourceProfile classifies detail html and adds commerce-oriented extract rules', () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://shop.example.com/products/widget-1',
    contentType: 'text/html; charset=utf-8',
    body: `
      <html lang="en">
        <head>
          <title>Widget 1</title>
          <meta property="product:price:amount" content="19.99" />
        </head>
        <body>
          <h1>Widget 1</h1>
          <div class="sku">SKU-001</div>
          <button>Add to Cart</button>
        </body>
      </html>
    `,
  });

  assert.equal(profile.kind, 'html');
  assert.equal(profile.pageKind, 'detail');
  assert.ok(profile.extractRules.some((rule) => rule.name === 'price'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'sku'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'availability'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'brand'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'rating'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'reviewCount'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'thumbnail'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'snippet'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'publishedAt'));
  assert.ok(profile.extractRules.some((rule) => rule.name === 'author'));
});

test('inferUniversalSourceProfile classifies listing and search html pages with result-oriented rules', () => {
  const listing = inferUniversalSourceProfile({
    url: 'https://shop.example.com/category/widgets',
    contentType: 'text/html',
    body: `
      <html>
        <head><title>Widget Catalog</title></head>
        <body>
          <div class="filters">Filters</div>
          <a href="/products/widget-1">Widget 1</a>
          <nav aria-label="pagination"><a rel="next" href="/category/widgets?page=2">Next</a></nav>
        </body>
      </html>
    `,
  });
  const search = inferUniversalSourceProfile({
    url: 'https://shop.example.com/search?q=widget',
    contentType: 'text/html',
    body: `
      <html>
        <head><title>Search results for widget</title></head>
        <body>
          <div>Results for widget</div>
          <a href="/products/widget-2">Widget 2</a>
        </body>
      </html>
    `,
  });

  assert.equal(listing.pageKind, 'listing');
  assert.ok(listing.extractRules.some((rule) => rule.name === 'resultLinks'));
  assert.ok(listing.extractRules.some((rule) => rule.name === 'paginationLinks'));

  assert.equal(search.pageKind, 'search');
  assert.ok(search.extractRules.some((rule) => rule.name === 'resultLinks'));
  assert.ok(search.extractRules.some((rule) => rule.name === 'paginationLinks'));
});

test('listing/search resultCards rule extracts structured cards from html and json-ld', async () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://shop.example.com/category/widgets',
    contentType: 'text/html',
    body: `
      <html>
        <head>
          <title>Widget Catalog</title>
          <script type="application/ld+json">
            {
              "@type": "ItemList",
              "itemListElement": [
                {
                  "item": {
                    "@type": "Product",
                    "name": "Widget Pro",
                    "url": "/products/widget-pro",
                    "image": "/img/widget-pro.jpg",
                    "brand": { "name": "Acme" },
                    "description": "Flagship widget",
                    "aggregateRating": { "ratingValue": "4.8", "reviewCount": "125" },
                    "offers": { "price": "29.99", "priceCurrency": "USD" }
                  }
                }
              ]
            }
          </script>
        </head>
        <body>
          <div class="product-card">
            <a href="/products/widget-lite">Widget Lite</a>
            <span class="brand">Acme Lite</span>
            <span class="price">$19.99</span>
            <span class="rating">4.6 out of 5</span>
            <span class="review-count">42 reviews</span>
            <img src="/img/widget-lite.jpg" />
          </div>
          <nav aria-label="pagination"><a rel="next" href="/category/widgets?page=2">Next</a></nav>
        </body>
      </html>
    `,
  });

  const extracted = await runExtractors({
    workflow: {
      extract: profile.extractRules.filter((rule) => rule.name === 'resultCards'),
      browser: {},
    },
    response: {
      body: `
        <html>
          <head>
            <title>Widget Catalog</title>
            <script type="application/ld+json">
              {
                "@type": "ItemList",
                "itemListElement": [
                  {
                    "item": {
                      "@type": "Product",
                      "name": "Widget Pro",
                      "url": "/products/widget-pro",
                      "image": "/img/widget-pro.jpg",
                      "brand": { "name": "Acme" },
                      "description": "Flagship widget",
                      "aggregateRating": { "ratingValue": "4.8", "reviewCount": "125" },
                      "offers": { "price": "29.99", "priceCurrency": "USD" }
                    }
                  }
                ]
              }
            </script>
          </head>
          <body>
            <div class="product-card">
              <a href="/products/widget-lite">Widget Lite</a>
              <span class="brand">Acme Lite</span>
              <span class="price">$19.99</span>
              <span class="rating">4.6 out of 5</span>
              <span class="review-count">42 reviews</span>
              <img src="/img/widget-lite.jpg" />
            </div>
            <nav aria-label="pagination"><a rel="next" href="/category/widgets?page=2">Next</a></nav>
          </body>
        </html>
      `,
      finalUrl: 'https://shop.example.com/category/widgets',
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    },
    logger: null,
  });

  assert.equal(profile.pageKind, 'listing');
  assert.ok(profile.extractRules.some((rule) => rule.name === 'resultCards'));
  assert.ok(Array.isArray(extracted.resultCards));
  assert.ok(extracted.resultCards.some((card) => card.title === 'Widget Pro' && card.source === 'jsonld' && card.brand === 'Acme' && card.rating === '4.8'));
  assert.ok(extracted.resultCards.some((card) => card.title === 'Widget Lite' && card.source === 'html' && card.brand === 'Acme Lite' && card.reviewCount === '42'));
});

test('frontendSignals and hydrationData rules expose bootstrap payloads', async () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://shop.example.com/app',
    contentType: 'text/html',
    body: `
      <html>
        <body>
          <div id="__next"></div>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[{"id":1}]}}}</script>
          <script>window.__INITIAL_STATE__ = {"viewer":{"id":"u1"}};</script>
        </body>
      </html>
    `,
  });

  const extracted = await runExtractors({
    workflow: {
      extract: profile.extractRules.filter((rule) => rule.name === 'frontendSignals' || rule.name === 'hydrationData'),
      browser: {},
    },
    response: {
      body: `
        <html>
          <body>
            <div id="__next"></div>
            <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[{"id":1}]}}}</script>
            <script>window.__INITIAL_STATE__ = {"viewer":{"id":"u1"}};</script>
          </body>
        </html>
      `,
      finalUrl: 'https://shop.example.com/app',
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
    },
    logger: null,
  });

  assert.ok(extracted.frontendSignals.frameworks.includes('nextjs'));
  assert.ok(extracted.frontendSignals.hydrationSources.includes('__NEXT_DATA__'));
  assert.equal(extracted.frontendSignals.appShellLikely, true);
  assert.equal(extracted.hydrationData.nextData.props.pageProps.items[0].id, 1);
  assert.equal(extracted.hydrationData.initialState.viewer.id, 'u1');
});

test('network extract rules expose fetch/xhr payloads for app-shell pages', async () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://shop.example.com/app',
    contentType: 'text/html',
    body: `
      <html>
        <body>
          <div id="__next"></div>
          <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"items":[{"id":1}]}}}</script>
        </body>
      </html>
    `,
  });

  const extracted = await runExtractors({
    workflow: {
      extract: profile.extractRules.filter((rule) => rule.name === 'networkPayloads' || rule.name === 'networkPrimaryData'),
      browser: {},
    },
    response: {
      body: '<html><body><div id="__next"></div></body></html>',
      finalUrl: 'https://shop.example.com/app',
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
      debug: {
        requests: [
          {
            url: 'https://shop.example.com/api/catalog',
            transport: 'fetch',
            method: 'POST',
            status: 200,
            mimeType: 'application/json',
            responseBody: {
              text: '{"items":[{"sku":"sku-1"}]}',
              bytes: 27,
            },
          },
        ],
      },
    },
    logger: null,
  });

  assert.ok(Array.isArray(extracted.networkPayloads));
  assert.equal(extracted.networkPayloads[0].url, 'https://shop.example.com/api/catalog');
  assert.equal(extracted.networkPayloads[0].transport, 'fetch');
  assert.deepEqual(extracted.networkPrimaryData, { items: [{ sku: 'sku-1' }] });
});

test('inferUniversalSourceProfile recommends auto-scroll for virtualized browser-shell listings', () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://shop.example.com/search?q=widget',
    contentType: 'text/html; charset=utf-8',
    body: `
      <html>
        <body>
          <div id="__next">
            <div role="feed" class="results-virtualized-list">
              <div role="listitem" data-index="0">Widget A</div>
              <div role="listitem" data-index="1">Widget B</div>
            </div>
            <button>Load more</button>
          </div>
          <script src="/_next/static/chunks/main.js"></script>
          <script>window.__NEXT_DATA__ = {"props":{"pageProps":{"query":"widget"}}};</script>
        </body>
      </html>
    `,
  });

  assert.equal(profile.mode, 'browser');
  assert.equal(profile.pageKind, 'search');
  assert.equal(profile.scroll.virtualListLikely, true);
  assert.equal(profile.scroll.loadMoreLikely, true);
  assert.equal(profile.scroll.recommendedAutoScroll, true);
  assert.equal(profile.scroll.autoScroll.enabled, true);
});

test('UniversalCrawler configureSource persists inferred auto-scroll into browser workflow config', () => {
  const profile = inferUniversalSourceProfile({
    url: 'https://shop.example.com/category/widgets',
    contentType: 'text/html; charset=utf-8',
    body: `
      <html>
        <body>
          <div id="__next">
            <div role="feed" class="product-results react-virtualized">
              <article data-index="0">Widget A</article>
              <article data-index="1">Widget B</article>
            </div>
            <a href="#more">Load more</a>
          </div>
          <script src="/_next/static/chunks/main.js"></script>
        </body>
      </html>
    `,
  });

  const crawler = new UniversalCrawler({ name: 'auto-scroll-profile' }).addSeedUrls('https://shop.example.com/category/widgets');
  crawler.configureSource(profile);
  const workflow = crawler._buildWorkflow();

  assert.equal(workflow.mode, 'browser');
  assert.equal(workflow.browser.autoScroll.enabled, true);
  assert.equal(workflow.browser.autoScroll.observeLazyContainers, true);
  assert.equal(workflow.browser.debug.captureNetwork, true);
});

test('UniversalCrawler prepareTarget auto-configures sitemap workflows', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.setHeader('content-type', 'application/xml; charset=utf-8');
      res.end(`
        <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
          <url><loc>http://127.0.0.1:${server.address().port}/a</loc></url>
        </urlset>
      `);
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/sitemap.xml`;
  const crawler = new UniversalCrawler({ name: 'universal-sitemap' });
  const profile = await crawler.prepareTarget(url);
  const workflow = crawler._buildWorkflow();

  assert.equal(profile.kind, 'sitemap');
  assert.equal(workflow.mode, 'cheerio');
  assert.match(workflow.headers.accept, /application\/xml/);
  assert.equal(workflow.discovery.enabled, true);
  assert.equal(workflow.discovery.extractor.type, 'xpath');
  assert.equal(workflow.discovery.extractor.xml, true);
  assert.ok(workflow.extract.some((rule) => rule.name === 'urls'));
  assert.equal(workflow.seedRequests[0].url, url);
});

test('UniversalCrawler prepareTarget auto-configures json workflows with default extract rules', async (t) => {
  const server = createServer((req, res) => {
    if (req.url === '/api/items') {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        items: [{ id: 1 }, { id: 2 }],
        pageInfo: {
          hasNextPage: true,
          nextCursor: 'cursor-2',
        },
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const url = `http://127.0.0.1:${server.address().port}/api/items`;
  const crawler = new UniversalCrawler({ name: 'universal-json' });
  const profile = await crawler.prepareTarget(url);
  const workflow = crawler._buildWorkflow();

  assert.equal(profile.kind, 'json');
  assert.equal(workflow.mode, 'http');
  assert.match(workflow.headers.accept, /application\/json/);
  assert.ok(Array.isArray(workflow.extract));
  assert.ok(workflow.extract.some((rule) => rule.name === 'document'));
  assert.ok(workflow.extract.some((rule) => rule.name === 'items'));
  assert.ok(workflow.extract.some((rule) => rule.name === 'nextCursor'));
  assert.ok(workflow.extract.some((rule) => rule.name === 'hasNextPage'));
});

test('TorCrawler binds the workflow proxy to the Tor socks endpoint', () => {
  const workflow = new TorCrawler({
    torProxy: 'socks5h://127.0.0.1:9050',
  })
    .addSeedUrls('https://example.com')
    ._buildWorkflow();

  assert.equal(workflow.proxy.server, 'socks5h://127.0.0.1:9050');
});
