import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLinksFallback } from '../src/extractors/extractor-engine.js';

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
