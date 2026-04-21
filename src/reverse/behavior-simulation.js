/**
 * Human Behavior Simulation Module
 *
 * Generates realistic human-like mouse movements, keyboard input,
 * and scrolling behavior to bypass bot detection systems like
 * PerimeterX, Imperva, and DataDome.
 */

import { addInitScriptCompat } from '../runtime/browser-page-compat.js';

/**
 * Generate cubic Bezier curve control points for mouse movement
 * Creates smooth, natural-looking mouse trajectories
 */
function cubicBezier(t, p0, p1, p2, p3) {
  if ([p0, p1, p2, p3].every((value) => typeof value === 'number')) {
    return {
      x: p0 + (p2 - p0) * t,
      y: p1 + (p3 - p1) * t,
    };
  }

  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Generate human-like mouse movement path using Bezier curves
 * @param {Object} start - Starting position {x, y}
 * @param {Object} end - Ending position {x, y}
 * @param {Object} options - Configuration options
 * @returns {Array} Array of {x, y, timestamp} points
 */
export function generateMousePath(start, end, options = {}) {
  if (start && typeof start === 'object' && end === undefined && ('startX' in start || 'endX' in start)) {
    options = {
      ...options,
      numPoints: start.steps ?? options.numPoints,
    };
    end = { x: Number(start.endX ?? 0), y: Number(start.endY ?? 0) };
    start = { x: Number(start.startX ?? 0), y: Number(start.startY ?? 0) };
  }

  const {
    numPoints = 20,
    wobble = 30, // Pixel wobble amount
    speedVariation = 0.3, // Speed variation factor
    hesitationChance = 0.1, // Chance of hesitation
    hesitationDuration = 200, // Hesitation duration in ms
  } = options;

  const path = [];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Control points for Bezier curve (with randomness)
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const controlOffsetX = (Math.random() - 0.5) * wobble * (distance / 500);
  const controlOffsetY = (Math.random() - 0.5) * wobble * (distance / 500);

  const p0 = { x: start.x, y: start.y };
  const p1 = { x: midX + controlOffsetX, y: midY - wobble };
  const p2 = { x: midX - controlOffsetX, y: midY + wobble };
  const p3 = { x: end.x, y: end.y };

  let currentTime = Date.now();
  const baseDelay = 10 + (distance / numPoints) * 2;

  for (let i = 0; i <= numPoints; i++) {
    const t = i / numPoints;
    // Add non-linear speed variation (humans accelerate/decelerate)
    const speedFactor = 1 + Math.sin(t * Math.PI) * speedVariation;
    const point = cubicBezier(t, p0, p1, p2, p3);

    // Add micro-jitter (hand tremor)
    point.x += (Math.random() - 0.5) * 2;
    point.y += (Math.random() - 0.5) * 2;

    path.push({
      x: Math.round(point.x),
      y: Math.round(point.y),
      timestamp: currentTime,
    });

    // Hesitation (humans sometimes pause mid-movement)
    if (Math.random() < hesitationChance) {
      currentTime += hesitationDuration * (0.5 + Math.random());
    } else {
      currentTime += baseDelay * speedFactor;
    }
  }

  return path;
}

/**
 * Generate human-like keyboard typing rhythm
 * @param {string} text - Text to type
 * @param {Object} options - Configuration options
 * @returns {Array} Array of {char, timestamp, delay} events
 */
export function generateTypingEvents(text, options = {}) {
  const {
    baseWPM = 60, // Words per minute
    wpmVariation = 0.4, // WPM variation
    errorRate = 0.02, // Typo/backspace rate
    pauseChance = 0.05, // Chance of pause while typing
    pauseDuration = 500, // Pause duration in ms
  } = options;

  const events = [];
  const baseDelay = 60000 / (baseWPM * 5); // Approx chars per minute
  let currentTime = Date.now();

  let i = 0;
  while (i < text.length) {
    const char = text[i];
    const speedFactor = 1 + (Math.random() - 0.5) * wpmVariation * 2;
    const delay = baseDelay * speedFactor;

    // Typo simulation (backspace and retype)
    if (Math.random() < errorRate && i > 0) {
      const backspaceCount = Math.floor(Math.random() * 3) + 1;
      const backspaceStart = Math.max(0, i - backspaceCount);
      const textToUndo = text.slice(backspaceStart, i);

      // Backspace events
      for (let j = 0; j < textToUndo.length; j++) {
        events.push({
          type: 'backspace',
          char: textToUndo[textToUndo.length - 1 - j],
          timestamp: currentTime,
          delay: 50 + Math.random() * 80,
        });
        currentTime += 50 + Math.random() * 80;
      }

      // Retype
      for (const ch of textToUndo) {
        const retypeDelay = baseDelay * (0.8 + Math.random() * 0.4);
        events.push({
          type: 'keypress',
          char: ch,
          timestamp: currentTime,
          delay: retypeDelay,
        });
        currentTime += retypeDelay;
      }

      // Continue from current position
      events.push({
        type: 'keypress',
        char,
        timestamp: currentTime,
        delay,
      });
      currentTime += delay;
      i++;
      continue;
    }

    // Random pause (thinking, looking at screen)
    if (Math.random() < pauseChance) {
      currentTime += pauseDuration * (0.5 + Math.random() * 1.5);
    }

    events.push({
      type: 'keypress',
      char,
      timestamp: currentTime,
      delay,
    });

    currentTime += delay;
    i++;
  }

  return events;
}

/**
 * Generate human-like scrolling behavior
 * @param {Object} options - Configuration options
 * @returns {Array} Array of {scrollY, velocity, timestamp} events
 */
export function generateScrollEvents(maxScroll, options = {}) {
  if (maxScroll && typeof maxScroll === 'object') {
    options = {
      ...options,
      maxScrollY: maxScroll.totalScroll ?? maxScroll.maxScrollY ?? options.maxScrollY,
    };
    maxScroll = maxScroll.totalScroll ?? maxScroll.maxScrollY ?? 0;
  }

  const {
    maxScrollY = maxScroll,
    baseSpeed = 300, // Pixels per second
    speedVariation = 0.5,
    pauseChance = 0.15,
    pauseDuration = 800,
    overshootChance = 0.2, // Scroll past and come back
    overshootAmount = 50,
  } = options;

  const events = [];
  let currentY = 0;
  let currentTime = Date.now();

  while (currentY < maxScrollY) {
    const remaining = maxScrollY - currentY;
    const scrollAmount = Math.min(
      remaining,
      (baseSpeed * (0.5 + Math.random() * speedVariation)) * (0.1 + Math.random() * 0.3),
    );

    // Overshoot and correct
    let actualScroll = scrollAmount;
    if (Math.random() < overshootChance && currentY + scrollAmount > maxScrollY * 0.8) {
      actualScroll = scrollAmount + overshootAmount * Math.random();
    }

    currentY = Math.min(maxScrollY, currentY + actualScroll);

    events.push({
      scrollY: Math.round(currentY),
      velocity: Math.round(scrollAmount * 10) / 10,
      timestamp: currentTime,
    });

    currentTime += 100 + Math.random() * 200;

    // Pause while reading
    if (Math.random() < pauseChance) {
      currentTime += pauseDuration * (0.5 + Math.random());
    }
  }

  // Final correction if overshoot
  if (events.length > 1) {
    const lastEvent = events[events.length - 1];
    if (lastEvent.scrollY > maxScrollY) {
      events.push({
        scrollY: maxScrollY,
        velocity: Math.round((lastEvent.scrollY - maxScrollY) * 10) / 10,
        timestamp: currentTime + 200,
      });
    }
  }

  return events;
}

/**
 * Generate complete human-like interaction sequence for a page
 * Combines mouse movement, typing, and scrolling
 * @param {Object} page - Page information
 * @param {Object} options - Configuration options
 * @returns {Array} Array of interaction events
 */
export function generateInteractionSequence(page = {}, options = {}) {
  if (page && typeof page === 'object' && ('mouse' in page || 'typing' in page || 'scroll' in page)) {
    const sequence = [];

    if (page.mouse) {
      sequence.push(...generateMousePath(page.mouse));
    }

    if (page.typing?.text) {
      sequence.push(...generateTypingEvents(page.typing.text, page.typing));
    }

    if (page.scroll) {
      sequence.push(...generateScrollEvents(page.scroll));
    }

    return sequence;
  }

  const {
    viewportWidth = 1920,
    viewportHeight = 1080,
    scrollable = true,
    maxScroll = 3000,
    typingTargets = [], // Elements to type into
    clickTargets = [], // Elements to click
  } = options;

  const events = [];
  let currentTime = Date.now();

  // Initial mouse movement from center of screen to first target
  const startPos = { x: viewportWidth / 2, y: viewportHeight / 2 };

  // Mouse to first clickable element
  if (clickTargets.length > 0) {
    const target = clickTargets[0];
    const mousePath = generateMousePath(startPos, { x: target.x, y: target.y }, {
      numPoints: 15 + Math.floor(Math.random() * 10),
    });

    for (const point of mousePath) {
      events.push({
        type: 'mousemove',
        x: point.x,
        y: point.y,
        timestamp: point.timestamp,
      });
    }

    currentTime = mousePath[mousePath.length - 1].timestamp + 100 + Math.random() * 300;

    // Click
    events.push({
      type: 'click',
      x: target.x,
      y: target.y,
      timestamp: currentTime,
    });

    currentTime += 200 + Math.random() * 500;
  }

  // Typing simulation
  if (typingTargets.length > 0) {
    for (const target of typingTargets) {
      // Move mouse to input
      const mousePath = generateMousePath(
        { x: events[events.length - 1]?.x ?? viewportWidth / 2, y: events[events.length - 1]?.y ?? viewportHeight / 2 },
        { x: target.x, y: target.y },
        { numPoints: 10 },
      );

      for (const point of mousePath) {
        events.push({
          type: 'mousemove',
          x: point.x,
          y: point.y,
          timestamp: point.timestamp,
        });
      }

      currentTime = mousePath[mousePath.length - 1].timestamp + 300 + Math.random() * 500;

      // Click to focus
      events.push({
        type: 'click',
        x: target.x,
        y: target.y,
        timestamp: currentTime,
      });

      currentTime += 200;

      // Type text
      const typingEvents = generateTypingEvents(target.text ?? '', {
        baseWPM: 40 + Math.random() * 40,
      });

      for (const te of typingEvents) {
        events.push({
          ...te,
          targetX: target.x,
          targetY: target.y,
        });
      }

      currentTime = typingEvents[typingEvents.length - 1].timestamp + 500;
    }
  }

  // Scrolling simulation
  if (scrollable) {
    const scrollEvents = generateScrollEvents(maxScroll, {
      maxScrollY: maxScroll,
    });

    for (const se of scrollEvents) {
      events.push({
        type: 'scroll',
        scrollY: se.scrollY,
        velocity: se.velocity,
        timestamp: se.timestamp,
      });
    }

    if (scrollEvents.length > 0) {
      currentTime = scrollEvents[scrollEvents.length - 1].timestamp;
    }
  }

  return events;
}

/**
 * Generate Puppeteer actions from interaction sequence
 * Can be used directly with Puppeteer page
 * @param {Object} page - Puppeteer page object
 * @param {Array} events - Interaction events
 * @param {Object} options - Options
 */
export async function executeInteractionSequence(page, events, options = {}) {
  const {
    delayFactor = 1, // Speed multiplier
    maxEvents = 100, // Max events to execute
    logProgress = false,
  } = options;

  const limitedEvents = events.slice(0, maxEvents);

  for (let i = 0; i < limitedEvents.length; i++) {
    const event = limitedEvents[i];

    switch (event.type) {
      case 'mousemove':
        await page.mouse.move(event.x, event.y);
        break;

      case 'click':
        await page.mouse.click(event.x, event.y);
        break;

      case 'keypress':
        await page.keyboard.type(event.char, { delay: event.delay * delayFactor });
        break;

      case 'backspace':
        await page.keyboard.press('Backspace');
        break;

      case 'scroll':
        await page.evaluate((scrollY) => {
          window.scrollTo(0, scrollY);
        }, event.scrollY);
        break;

      default:
        break;
    }

    if (logProgress && i % 10 === 0) {
      console.log(`[Behavior] Executed ${i + 1}/${limitedEvents.length} events`);
    }

    // Wait for next event timestamp
    if (i < limitedEvents.length - 1) {
      const nextEvent = limitedEvents[i + 1];
      const waitTime = Math.max(10, (nextEvent.timestamp - event.timestamp) * delayFactor);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
  }
}

/**
 * Inject behavior simulation hooks into browser page
 * Adds event listeners that generate realistic interaction data
 * @param {Object} page - Puppeteer page object
 * @param {Object} options - Options
 */
export async function injectBehaviorSimulation(page, options = {}) {
  const {
    logEvents = false,
    storeInVariable = true,
  } = options;

  await addInitScriptCompat(page, (opts) => {
    // Store simulated behavior events
    if (opts.storeInVariable) {
      window.__simulatedBehavior = {
        mouseMovements: [],
        keypresses: [],
        scrolls: [],
        clicks: [],
        startTime: Date.now(),
      };
    }

    // Track real user interactions (for replay)
    const behaviorLog = opts.storeInVariable ? window.__simulatedBehavior : null;

    if (opts.logEvents || opts.storeInVariable) {
      document.addEventListener('mousemove', (e) => {
        const event = {
          type: 'mousemove',
          x: e.clientX,
          y: e.clientY,
          timestamp: Date.now(),
        };
        if (opts.logEvents) console.log('[Behavior]', event);
        if (behaviorLog) behaviorLog.mouseMovements.push(event);
      });

      document.addEventListener('keydown', (e) => {
        const event = {
          type: 'keypress',
          key: e.key,
          code: e.code,
          timestamp: Date.now(),
        };
        if (opts.logEvents) console.log('[Behavior]', event);
        if (behaviorLog) behaviorLog.keypresses.push(event);
      });

      window.addEventListener('scroll', () => {
        const event = {
          type: 'scroll',
          scrollY: window.scrollY || window.pageYOffset,
          timestamp: Date.now(),
        };
        if (opts.logEvents) console.log('[Behavior]', event);
        if (behaviorLog) behaviorLog.scrolls.push(event);
      });

      document.addEventListener('click', (e) => {
        const event = {
          type: 'click',
          x: e.clientX,
          y: e.clientY,
          timestamp: Date.now(),
        };
        if (opts.logEvents) console.log('[Behavior]', event);
        if (behaviorLog) behaviorLog.clicks.push(event);
      });
    }
  }, { logEvents, storeInVariable });
}

/**
 * Get behavior analysis score for a sequence of events
 * Evaluates how "human-like" the interaction pattern is
 * @param {Array} events - Interaction events
 * @returns {Object} Behavior analysis result
 */
export function analyzeBehaviorPattern(events = []) {
  const mouseEvents = events.filter((e) => e.type === 'mousemove' || (e.type === undefined && Number.isFinite(e?.x) && Number.isFinite(e?.y)));
  const keyEvents = events.filter((e) => e.type === 'keypress');
  const scrollEvents = events.filter((e) => e.type === 'scroll');
  const clickEvents = events.filter((e) => e.type === 'click');

  // Mouse movement smoothness
  let mouseSmoothness = 1;
  if (mouseEvents.length > 2) {
    const angles = [];
    for (let i = 1; i < mouseEvents.length - 1; i++) {
      const dx1 = mouseEvents[i].x - mouseEvents[i - 1].x;
      const dy1 = mouseEvents[i].y - mouseEvents[i - 1].y;
      const dx2 = mouseEvents[i + 1].x - mouseEvents[i].x;
      const dy2 = mouseEvents[i + 1].y - mouseEvents[i].y;
      const angle = Math.atan2(dy2, dx2) - Math.atan2(dy1, dx1);
      angles.push(Math.abs(angle));
    }
    const avgAngle = angles.reduce((a, b) => a + b, 0) / angles.length;
    mouseSmoothness = Math.max(0, 1 - avgAngle / Math.PI);
  }

  // Typing rhythm variance
  let typingVariance = 0;
  if (keyEvents.length > 2) {
    const intervals = [];
    for (let i = 1; i < keyEvents.length; i++) {
      intervals.push(keyEvents[i].timestamp - keyEvents[i - 1].timestamp);
    }
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    typingVariance = Math.sqrt(variance) / mean; // Coefficient of variation
  }

  // Human-likeness score
  const humanScore = Math.round(
    (mouseSmoothness * 0.4 + Math.min(1, typingVariance) * 0.3 + 0.3) * 100,
  );

  return {
    humanScore,
    score: humanScore,
    humanLikeness: humanScore,
    metrics: {
      mouseSmoothness: Math.round(mouseSmoothness * 100),
      typingVariance: Math.round(typingVariance * 100) / 100,
      totalEvents: events.length,
      mouseEventCount: mouseEvents.length,
      keyEventCount: keyEvents.length,
      scrollEventCount: scrollEvents.length,
      clickEventCount: clickEvents.length,
    },
    verdict: humanScore > 70 ? 'human-like' : humanScore > 40 ? 'uncertain' : 'bot-like',
  };
}

export {
  cubicBezier,
};
