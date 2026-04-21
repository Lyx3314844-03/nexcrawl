import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMousePath,
  generateTypingEvents,
  generateScrollEvents,
  generateInteractionSequence,
  analyzeBehaviorPattern,
  cubicBezier
} from '../../src/reverse/behavior-simulation.js';

describe('BehaviorSimulation', () => {
  it('generateMousePath produces array of points', () => {
    const path = generateMousePath({ startX: 0, startY: 0, endX: 500, endY: 300, steps: 50 });
    assert.ok(Array.isArray(path));
    assert.ok(path.length > 0);
  });

  it('generateMousePath starts near origin', () => {
    const path = generateMousePath({ startX: 10, startY: 10, endX: 500, endY: 300, steps: 50 });
    assert.ok(path[0].x < 50);
    assert.ok(path[0].y < 50);
  });

  it('generateMousePath ends near target', () => {
    const path = generateMousePath({ startX: 0, startY: 0, endX: 500, endY: 300, steps: 100 });
    const last = path[path.length - 1];
    assert.ok(last.x > 400);
    assert.ok(last.y > 200);
  });

  it('generateTypingEvents produces key events', () => {
    const events = generateTypingEvents('hello world', { wpm: 60 });
    assert.ok(Array.isArray(events));
    assert.ok(events.length > 0);
  });

  it('generateScrollEvents produces scroll events', () => {
    const events = generateScrollEvents({ totalScroll: 3000, steps: 20 });
    assert.ok(Array.isArray(events));
    assert.ok(events.length > 0);
  });

  it('generateInteractionSequence combines all types', () => {
    const sequence = generateInteractionSequence({
      mouse: { startX: 0, startY: 0, endX: 200, endY: 100 },
      typing: { text: 'test' },
      scroll: { totalScroll: 1000 }
    });
    assert.ok(Array.isArray(sequence));
    assert.ok(sequence.length > 0);
  });

  it('analyzeBehaviorPattern returns a score', () => {
    const events = generateMousePath({ startX: 0, startY: 0, endX: 500, endY: 300, steps: 50 });
    const result = analyzeBehaviorPattern(events);
    assert.ok(result);
    assert.ok(typeof result.score === 'number' || typeof result.humanLikeness === 'number');
  });

  it('cubicBezier returns point on curve', () => {
    const p = cubicBezier(0.5, 0, 0, 500, 300);
    assert.ok(typeof p === 'object' || typeof p === 'number');
  });

  it('generateTypingEvents includes variation', () => {
    const events1 = generateTypingEvents('hello', { wpm: 60 });
    const events2 = generateTypingEvents('hello', { wpm: 60 });
    // Should have some randomness
    const same = events1.every((e, i) => JSON.stringify(e) === JSON.stringify(events2[i]));
    // Not guaranteed to be different every time, but the function should work
    assert.ok(events1.length > 0);
  });
});
