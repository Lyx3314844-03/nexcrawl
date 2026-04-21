export async function addInitScriptCompat(page, script, arg) {
  if (!page || !script) {
    return;
  }

  if (typeof page.evaluateOnNewDocument === 'function') {
    if (typeof script === 'string') {
      await page.evaluateOnNewDocument(script);
      return;
    }
    await page.evaluateOnNewDocument(script, arg);
    return;
  }

  if (typeof page.addInitScript === 'function') {
    const content = typeof script === 'string'
      ? `(() => {\n${script}\n})();`
      : `(${script.toString()})(${arg === undefined ? 'undefined' : JSON.stringify(arg)});`;
    await page.addInitScript(content);
    return;
  }

  throw new Error('Browser page does not support init script injection');
}

export async function setUserAgentCompat(page, userAgent) {
  if (!page || !userAgent) {
    return;
  }

  if (typeof page.setUserAgent === 'function') {
    await page.setUserAgent(userAgent);
    return;
  }

  await page.setExtraHTTPHeaders?.({ 'user-agent': userAgent }).catch(() => {});
  await addInitScriptCompat(page, (ua) => {
    try {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => ua,
        configurable: true,
      });
    } catch (_error) {}
  }, userAgent).catch(() => {});
}

export async function setViewportCompat(page, viewport) {
  if (!page || !viewport || typeof viewport !== 'object') {
    return;
  }

  if (typeof page.setViewport === 'function') {
    await page.setViewport(viewport);
    return;
  }

  await page.setViewportSize?.(viewport);
}
