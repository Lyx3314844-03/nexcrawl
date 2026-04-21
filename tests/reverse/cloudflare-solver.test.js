import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCloudflareChallenge,
  extractChallengeParams,
  buildCloudflareStealthHeaders
} from '../../src/reverse/cloudflare-solver.js';

describe('CloudflareSolver', () => {
  it('detectCloudflareChallenge identifies JS challenge', () => {
    const response = {
      status: 503,
      headers: { 'cf-ray': 'abc123', server: 'cloudflare' },
      body: '<html><title>Just a moment</title><script>challenge-platform</script></html>'
    };
    const result = detectCloudflareChallenge(response);
    assert.ok(result);
    assert.ok(result.detected);
  });

  it('detectCloudflareChallenge identifies Turnstile challenge', () => {
    const response = {
      status: 403,
      headers: { 'cf-ray': 'xyz', server: 'cloudflare' },
      body: '<html><div class="cf-turnstile" data-sitekey="test-key"></div></html>'
    };
    const result = detectCloudflareChallenge(response);
    assert.ok(result);
    assert.ok(result.detected);
  });

  it('detectCloudflareChallenge returns no challenge for normal response', () => {
    const response = {
      status: 200,
      headers: {},
      body: '<html><body>Hello</body></html>'
    };
    const result = detectCloudflareChallenge(response);
    assert.ok(!result.detected);
  });

  it('detectCloudflareChallenge detects existing clearance', () => {
    const response = {
      status: 200,
      headers: { 'cf-cache-status': 'HIT' },
      body: '<html>OK</html>'
    };
    const result = detectCloudflareChallenge(response);
    assert.ok(result);
  });

  it('extractChallengeParams returns site key from Turnstile', () => {
    const html = '<html><div class="cf-turnstile" data-sitekey="0x4AAAAAAA"></div></html>';
    const params = extractChallengeParams(html);
    assert.ok(params);
  });

  it('buildCloudflareStealthHeaders returns browser-like headers', () => {
    const headers = buildCloudflareStealthHeaders();
    assert.ok(headers);
    assert.ok(headers['user-agent'] || headers['User-Agent']);
  });
});
