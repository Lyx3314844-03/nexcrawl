import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { STEALTH_ARGS, buildAntiDetectionHook, applyStealthProfile } from '../../src/reverse/stealth-profile.js';

describe('StealthProfile', () => {
  it('STEALTH_ARGS contains anti-detection flags', () => {
    assert.ok(Array.isArray(STEALTH_ARGS));
    assert.ok(STEALTH_ARGS.length > 0);
    assert.ok(STEALTH_ARGS.some(a => a.includes('AutomationControlled') || a.includes('automation')));
  });

  it('STEALTH_ARGS disables blink automation features', () => {
    assert.ok(STEALTH_ARGS.some(a => a.includes('disable-blink-features')));
  });

  it('buildAntiDetectionHook returns a string', () => {
    const hook = buildAntiDetectionHook({});
    assert.ok(typeof hook === 'string');
    assert.ok(hook.length > 100);
  });

  it('buildAntiDetectionHook includes navigator masking', () => {
    const hook = buildAntiDetectionHook({ navigator: { webdriver: false } });
    assert.ok(hook.includes('navigator') || hook.includes('webdriver'));
  });

  it('buildAntiDetectionHook includes WebGL masking', () => {
    const hook = buildAntiDetectionHook({});
    assert.ok(hook.includes('WebGL') || hook.includes('webgl') || hook.includes('getParameter'));
  });

  it('buildAntiDetectionHook includes Canvas noise injection', () => {
    const hook = buildAntiDetectionHook({});
    assert.ok(hook.includes('Canvas') || hook.includes('canvas') || hook.includes('toDataURL'));
  });

  it('buildAntiDetectionHook includes WebRTC leak prevention', () => {
    const hook = buildAntiDetectionHook({});
    assert.ok(hook.includes('RTCPeerConnection') || hook.includes('webrtc') || hook.includes('STUN'));
  });

  it('applyStealthProfile is an async function', () => {
    assert.equal(typeof applyStealthProfile, 'function');
    // Can't actually test without a browser page, but verify it's exported
  });
});
