import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADER_ORDER_MAP,
  getHeaderOrder,
  reorderHeaders,
  buildOrderedFetchHeaders
} from '../../src/fetchers/header-order.js';

describe('Header Order', () => {
  it('HEADER_ORDER_MAP contains Chrome, Firefox, Safari, and Edge', () => {
    assert.ok(HEADER_ORDER_MAP['chrome-123'] || HEADER_ORDER_MAP['chrome-latest']);
    assert.ok(HEADER_ORDER_MAP['firefox-124'] || HEADER_ORDER_MAP['firefox-latest']);
    assert.ok(HEADER_ORDER_MAP['safari-17'] || HEADER_ORDER_MAP['safari-latest']);
    assert.ok(HEADER_ORDER_MAP['edge'] || HEADER_ORDER_MAP['edge-latest']);
  });

  it('getHeaderOrder returns array for known browser', () => {
    const order = getHeaderOrder('chrome-123') || getHeaderOrder('chrome-latest');
    assert.ok(Array.isArray(order));
    assert.ok(order.length > 0);
    assert.ok(order.includes('host') || order.includes('user-agent'));
  });

  it('getHeaderOrder returns undefined for unknown browser', () => {
    const order = getHeaderOrder('nonexistent-browser');
    assert.equal(order, undefined);
  });

  it('reorderHeaders splits into ordered and remaining', () => {
    const headers = { host: 'example.com', 'user-agent': 'test', accept: '*/*', 'x-custom': 'val' };
    const profile = 'chrome-123';
    const [ordered, remaining] = reorderHeaders(headers, profile);
    assert.ok(Array.isArray(ordered));
    assert.ok(Array.isArray(remaining));
    // Ordered should contain browser-standard headers
    assert.ok(ordered.length > 0);
    // Remaining should contain non-standard headers
    const remainingKeys = remaining.map(([k]) => k);
    assert.ok(remainingKeys.includes('x-custom'));
  });

  it('buildOrderedFetchHeaders constructs Headers object', () => {
    const headers = { host: 'example.com', 'user-agent': 'test', accept: '*/*' };
    const result = buildOrderedFetchHeaders(headers, 'chrome-123');
    assert.ok(result);
  });

  it('handles empty headers gracefully', () => {
    const [ordered, remaining] = reorderHeaders({}, 'chrome-123');
    assert.ok(Array.isArray(ordered));
    assert.equal(ordered.length, 0);
    assert.equal(remaining.length, 0);
  });
});
