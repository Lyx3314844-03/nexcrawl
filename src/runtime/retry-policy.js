function getHeaderValue(headers = {}, headerName) {
  const targetName = String(headerName).toLowerCase();

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (String(key).toLowerCase() === targetName) {
      if (Array.isArray(value)) {
        return value[0] ?? null;
      }

      return value ?? null;
    }
  }

  return null;
}

export function parseRetryAfterMs(value, now = Date.now()) {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  const parsedAt = Date.parse(trimmed);
  if (Number.isNaN(parsedAt)) {
    return null;
  }

  return Math.max(0, parsedAt - now);
}

export function computeRetryDelayMs({ attempt = 1, response = null, retry = {}, random = Math.random } = {}) {
  const baseBackoffMs = Math.max(0, Number(retry.backoffMs ?? 0));
  const strategy = String(retry.strategy ?? 'fixed');
  const maxBackoffMs = Math.max(baseBackoffMs, Number(retry.maxBackoffMs ?? baseBackoffMs));
  const jitterRatio = Math.max(0, Math.min(1, Number(retry.jitterRatio ?? 0)));

  let delayMs = baseBackoffMs;
  if (strategy === 'exponential' && baseBackoffMs > 0) {
    delayMs = baseBackoffMs * (2 ** Math.max(0, attempt - 1));
  }

  if (maxBackoffMs > 0) {
    delayMs = Math.min(delayMs, maxBackoffMs);
  }

  if (retry.respectRetryAfter !== false && response) {
    const retryAfterMs = parseRetryAfterMs(getHeaderValue(response.headers, 'retry-after'));
    if (retryAfterMs !== null) {
      delayMs = Math.max(delayMs, retryAfterMs);
    }
  }

  if (jitterRatio > 0 && delayMs > 0) {
    const spreadMs = delayMs * jitterRatio;
    const minDelayMs = Math.max(0, delayMs - spreadMs);
    const maxDelayMs = delayMs + spreadMs;
    delayMs = Math.round(minDelayMs + ((maxDelayMs - minDelayMs) * random()));
  }

  return Math.max(0, Math.round(delayMs));
}
