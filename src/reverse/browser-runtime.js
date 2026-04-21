import { acquireBrowserLease } from '../runtime/browser-pool.js';
import { applyStealthProfile, buildAntiDetectionHook } from './stealth-profile.js';

export async function executeInChromium(payload = {}) {
  const timeoutMs = Number(payload.timeoutMs ?? 5000);
  const waitUntil = payload.waitUntil ?? 'load';
  const logs = [];
  const browserConfig = {
    engine: typeof payload.engine === 'string' ? payload.engine : undefined,
    headless: payload.headless ?? true,
    executablePath: payload.executablePath,
    launchArgs: Array.isArray(payload.launchArgs) ? payload.launchArgs : [],
    viewport: payload.viewport && typeof payload.viewport === 'object' ? payload.viewport : undefined,
    pool: payload.pool && typeof payload.pool === 'object' ? payload.pool : undefined,
  };
  const session = payload.session && typeof payload.session === 'object' ? payload.session : null;
  const lease = await acquireBrowserLease({
    browserConfig,
    sessionId: session?.id ?? null,
    isolate: session?.isolate ?? true,
  });
  const page = await lease.context.newPage();
  const cdp = await lease.createCdpSession(page);
  const normalizedWaitUntil = lease.normalizeWaitUntil(waitUntil);

  try {
    page.on('console', (message) => {
      logs.push({
        type: message.type(),
        text: message.text(),
      });
    });

    if (payload.viewport && typeof payload.viewport === 'object') {
      await lease.setViewport(page, payload.viewport);
    }

    await applyStealthProfile({
      page,
      cdp,
      options: {
        ...browserConfig,
        timezoneId: payload.timezoneId,
      },
    });
    const stealthHook = buildAntiDetectionHook({
      ...browserConfig,
      timezoneId: payload.timezoneId,
    });
    await lease.addInitScript(page, stealthHook);
    await page.evaluate((source) => {
      // eslint-disable-next-line no-eval
      return globalThis.eval(source);
    }, stealthHook).catch(() => {});

    if (typeof payload.userAgent === 'string' && payload.userAgent) {
      await lease.setUserAgent(page, payload.userAgent);
    }

    if (Array.isArray(payload.cookies) && payload.cookies.length > 0) {
      await lease.setCookies(page, payload.cookies);
    }

    if (typeof payload.url === 'string' && payload.url) {
      await page.goto(payload.url, { waitUntil: normalizedWaitUntil, timeout: timeoutMs });
    } else {
      await page.setContent(payload.html ?? '<html><body></body></html>', {
        waitUntil: normalizedWaitUntil,
        timeout: timeoutMs,
      });
    }

    if (typeof payload.code === 'string' && payload.code) {
      await page.evaluate((code) => globalThis.eval(code), payload.code);
    }

    const result = typeof payload.expression === 'string' && payload.expression
      ? await page.evaluate((expression) => globalThis.eval(expression), payload.expression)
      : null;

    const cookies = await lease.getCookies(page);
    const html = await page.content();

    return {
      kind: 'browser-execute',
      engine: lease.backend,
      backendFamily: lease.backendFamily,
      requestedEngine: lease.requestedEngine,
      result,
      cookies,
      logs,
      html,
      url: page.url(),
    };
  } finally {
    await page.close().catch(() => {});
    await lease.release();
  }
}
