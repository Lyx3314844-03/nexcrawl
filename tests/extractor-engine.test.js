import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinksFallback, runExtractors } from '../src/extractors/extractor-engine.js';

test('extractLinksFallback can emit structured link objects', () => {
  const links = extractLinksFallback(
    '<a href="/detail">Detail</a><a href="https://example.com/list">List</a>',
    'https://shop.example.com/root',
    10,
    { format: 'object' },
  );

  assert.deepEqual(links, [
    {
      url: 'https://shop.example.com/detail',
      text: null,
      tagName: 'a',
      rel: null,
      nofollow: false,
      hreflang: null,
      mediaType: null,
    },
    {
      url: 'https://example.com/list',
      text: null,
      tagName: 'a',
      rel: null,
      nofollow: false,
      hreflang: null,
      mediaType: null,
    },
  ]);
});

test('network extractor prefers successful fetch/xhr JSON payloads from browser debug capture', async () => {
  const extracted = await runExtractors({
    workflow: {
      browser: {},
      extract: [
        {
          name: 'networkPayloads',
          type: 'network',
          transports: ['fetch', 'xhr'],
          all: true,
          includeMeta: true,
          maxItems: 5,
        },
        {
          name: 'networkPrimaryData',
          type: 'network',
          transports: ['fetch', 'xhr'],
        },
      ],
    },
    response: {
      body: '<html><body>app shell</body></html>',
      finalUrl: 'https://example.com/app',
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
      debug: {
        requests: [
          {
            url: 'https://example.com/api/bootstrap',
            transport: 'fetch',
            method: 'POST',
            status: 200,
            mimeType: 'application/json',
            responseBody: {
              text: '{"data":{"items":[{"id":1},{"id":2}]}}',
              bytes: 34,
            },
          },
          {
            url: 'https://example.com/api/metrics',
            transport: 'xhr',
            method: 'GET',
            status: 204,
            mimeType: 'application/json',
            responseBody: {
              text: '',
              bytes: 0,
            },
          },
        ],
      },
    },
    logger: null,
  });

  assert.ok(Array.isArray(extracted.networkPayloads));
  assert.equal(extracted.networkPayloads[0].url, 'https://example.com/api/bootstrap');
  assert.equal(extracted.networkPayloads[0].transport, 'fetch');
  assert.deepEqual(extracted.networkPrimaryData, { data: { items: [{ id: 1 }, { id: 2 }] } });
});

test('network extractor can prioritize likely data interfaces and unwrap primary data', async () => {
  const extracted = await runExtractors({
    workflow: {
      browser: {},
      extract: [
        {
          name: 'networkPayloads',
          type: 'network',
          transports: ['fetch', 'xhr'],
          selection: 'payload',
          all: true,
          includeMeta: true,
          maxItems: 5,
        },
        {
          name: 'networkPrimaryData',
          type: 'network',
          transports: ['fetch', 'xhr'],
          selection: 'primary-data',
          includeMeta: true,
        },
      ],
    },
    response: {
      body: '<html><body>dynamic app</body></html>',
      finalUrl: 'https://example.com/app',
      headers: {
        'content-type': 'text/html; charset=utf-8',
      },
      debug: {
        requests: [
          {
            url: 'https://example.com/api/track',
            transport: 'fetch',
            method: 'POST',
            status: 200,
            mimeType: 'application/json',
            responseBody: {
              text: '{"ok":true}',
              bytes: 11,
            },
          },
          {
            url: 'https://example.com/api/token',
            transport: 'xhr',
            method: 'POST',
            mimeType: 'application/json',
            status: 200,
            responseBody: {
              text: '{"token":"demo","expiresIn":3600}',
              bytes: 33,
            },
          },
          {
            url: 'https://example.com/graphql',
            transport: 'fetch',
            method: 'POST',
            mimeType: 'application/json',
            status: 200,
            requestBody: {
              text: '{"operationName":"CatalogQuery","query":"query CatalogQuery { catalog { items { id } pageInfo { hasNextPage } } }"}',
              bytes: 111,
            },
            responseBody: {
              text: '{"data":{"catalog":{"items":[{"id":1}],"pageInfo":{"hasNextPage":true}}}}',
              bytes: 74,
            },
          },
        ],
      },
    },
    logger: null,
  });

  assert.ok(Array.isArray(extracted.networkPayloads));
  assert.equal(extracted.networkPayloads[0].url, 'https://example.com/graphql');
  assert.equal(extracted.networkPayloads[0].apiCategory, 'graphql');
  assert.equal(extracted.networkPrimaryData.apiCategory, 'graphql');
  assert.equal(extracted.networkPrimaryData.selectedBy, 'primary-data');
  assert.equal(extracted.networkPrimaryData.dataPath, 'data.catalog');
  assert.deepEqual(extracted.networkPrimaryData.data, {
    items: [{ id: 1 }],
    pageInfo: {
      hasNextPage: true,
    },
  });
});
