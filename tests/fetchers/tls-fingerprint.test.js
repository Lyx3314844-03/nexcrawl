import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROWSER_PROFILES,
  calculateJA3,
  calculateJA4,
  getBrowserTLSProfile,
  getAvailableTLSProfiles,
  buildTLSOptions,
  createTLSAgent
} from '../../src/fetchers/tls-fingerprint.js';

describe('TLS Fingerprint', () => {
  it('BROWSER_PROFILES contains Chrome, Firefox, and Safari', () => {
    assert.ok(BROWSER_PROFILES['chrome-123'] || BROWSER_PROFILES['chrome-latest']);
    assert.ok(BROWSER_PROFILES['firefox-124'] || BROWSER_PROFILES['firefox-latest']);
    assert.ok(BROWSER_PROFILES['safari-17'] || BROWSER_PROFILES['safari-latest']);
  });

  it('getBrowserTLSProfile returns profile for known browser', () => {
    const profile = getBrowserTLSProfile('chrome-123') || getBrowserTLSProfile('chrome-latest');
    assert.ok(profile);
    assert.ok(profile.ciphers);
    assert.ok(profile.extensions);
  });

  it('getBrowserTLSProfile returns null/undefined for unknown browser', () => {
    const profile = getBrowserTLSProfile('nonexistent-browser');
    assert.ok(!profile);
  });

  it('getAvailableTLSProfiles returns list of profiles', () => {
    const profiles = getAvailableTLSProfiles();
    assert.ok(Array.isArray(profiles));
    assert.ok(profiles.length >= 3);
  });

  it('calculateJA3 produces a fingerprint string', () => {
    const ja3 = calculateJA3({
      ciphers: [4865, 4866, 4867],
      extensions: [0, 23, 65281],
      ellipticCurves: [29, 23, 24],
      ecPointFormats: [0]
    });
    assert.ok(typeof ja3 === 'string');
    assert.ok(ja3.length > 0);
  });

  it('calculateJA4 produces a fingerprint string', () => {
    const ja4 = calculateJA4({
      tlsVersion: '0x0303',
      ciphers: [4865, 4866],
      extensions: [0, 23, 65281],
      signatureAlgorithms: [1027, 2052]
    });
    assert.ok(typeof ja4 === 'string');
    assert.ok(ja4.length > 0);
  });

  it('buildTLSOptions returns Node.js https options', () => {
    const profile = getBrowserTLSProfile('chrome-123') || getBrowserTLSProfile('chrome-latest');
    const options = buildTLSOptions(profile);
    assert.ok(options);
    assert.ok(options.ciphers || options.secureOptions);
  });

  it('createTLSAgent creates an https.Agent', () => {
    const profile = getBrowserTLSProfile('chrome-123') || getBrowserTLSProfile('chrome-latest');
    const options = buildTLSOptions(profile);
    const agent = createTLSAgent(options);
    assert.ok(agent);
  });
});
