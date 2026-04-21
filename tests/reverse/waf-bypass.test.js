import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectWaf,
  buildAkamaiHeaders,
  buildPerimeterXHeaders,
  buildPerimeterXEvasionScript,
  buildDataDomeHeaders,
  getWafBypassConfig
} from '../../src/reverse/waf-bypass.js';

describe('WAF Bypass', () => {
  it('detectWaf identifies Akamai', () => {
    const response = { status: 403, headers: { 'x-akamai-transformed': '1' }, body: '' };
    const waf = detectWaf(response);
    assert.ok(waf);
    assert.equal(waf.name === 'akamai' || waf === 'akamai', true);
  });

  it('detectWaf identifies PerimeterX', () => {
    const response = { status: 403, headers: { 'x-px-vid': 'abc' }, body: '' };
    const waf = detectWaf(response);
    assert.ok(waf);
  });

  it('detectWaf identifies DataDome', () => {
    const response = { status: 403, headers: { 'x-datadome': '1' }, body: '' };
    const waf = detectWaf(response);
    assert.ok(waf);
  });

  it('detectWaf returns null for normal response', () => {
    const response = { status: 200, headers: {}, body: '' };
    const waf = detectWaf(response);
    assert.ok(!waf || waf.name === 'none');
  });

  it('buildAkamaiHeaders returns browser-like headers', () => {
    const headers = buildAkamaiHeaders({});
    assert.ok(headers);
    assert.ok(typeof headers === 'object');
  });

  it('buildPerimeterXHeaders returns headers', () => {
    const headers = buildPerimeterXHeaders({});
    assert.ok(headers);
  });

  it('buildPerimeterXEvasionScript returns JS string', () => {
    const script = buildPerimeterXEvasionScript();
    assert.ok(typeof script === 'string');
    assert.ok(script.length > 50);
  });

  it('buildDataDomeHeaders returns headers', () => {
    const headers = buildDataDomeHeaders({});
    assert.ok(headers);
  });

  it('getWafBypassConfig returns unified config for Akamai', () => {
    const config = getWafBypassConfig('akamai', {});
    assert.ok(config);
    assert.ok(config.headers || config.browserMode !== undefined);
  });
});
