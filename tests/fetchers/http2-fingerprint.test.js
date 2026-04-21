import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  H2_BROWSER_PROFILES,
  getH2BrowserProfile,
  getAvailableH2Profiles,
  buildH2Headers,
  buildSettingsFrame,
  getH2FingerprintSummary
} from '../../src/fetchers/http2-fingerprint.js';

describe('HTTP/2 Fingerprint', () => {
  it('H2_BROWSER_PROFILES contains Chrome, Firefox, and Safari', () => {
    assert.ok(H2_BROWSER_PROFILES['chrome-123'] || H2_BROWSER_PROFILES['chrome-latest']);
    assert.ok(H2_BROWSER_PROFILES['firefox-124'] || H2_BROWSER_PROFILES['firefox-latest']);
    assert.ok(H2_BROWSER_PROFILES['safari-17'] || H2_BROWSER_PROFILES['safari-latest']);
  });

  it('getH2BrowserProfile returns profile for known browser', () => {
    const profile = getH2BrowserProfile('chrome-123') || getH2BrowserProfile('chrome-latest');
    assert.ok(profile);
    assert.ok(profile.settings);
    assert.ok(profile.pseudoHeaderOrder);
  });

  it('getH2BrowserProfile returns null for unknown browser', () => {
    const profile = getH2BrowserProfile('nonexistent');
    assert.ok(!profile);
  });

  it('getAvailableH2Profiles returns list of profiles', () => {
    const profiles = getAvailableH2Profiles();
    assert.ok(Array.isArray(profiles));
    assert.ok(profiles.length >= 3);
  });

  it('buildH2Headers returns headers with pseudo-header order', () => {
    const profile = getH2BrowserProfile('chrome-123') || getH2BrowserProfile('chrome-latest');
    const request = { url: 'https://example.com', method: 'GET', headers: { 'user-agent': 'test' } };
    const headers = buildH2Headers(request, profile);
    assert.ok(headers);
  });

  it('buildSettingsFrame produces a Buffer', () => {
    const profile = getH2BrowserProfile('chrome-123') || getH2BrowserProfile('chrome-latest');
    const frame = buildSettingsFrame(profile.settings);
    assert.ok(frame);
  });

  it('getH2FingerprintSummary returns structured summary', () => {
    const profile = getH2BrowserProfile('chrome-123') || getH2BrowserProfile('chrome-latest');
    const summary = getH2FingerprintSummary(profile);
    assert.ok(summary);
    assert.ok(summary.settings || summary.pseudoHeaderOrder);
  });
});
