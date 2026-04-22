import { setTimeout as sleep } from 'node:timers/promises';
import { fetchWithHttp } from '../fetchers/http-fetcher.js';
import { fetchWithCheerio } from '../fetchers/cheerio-fetcher.js';
import { fetchWithBrowser } from '../fetchers/browser-fetcher.js';
import { fetchWebSocketResponse } from '../fetchers/ws-fetcher.js';
import { fetchGrpcResponse } from './grpc-crawler.js';
import { assessResultQuality } from './quality-monitor.js';
import { buildResultIdentitySnapshot, inspectResultDiagnostics } from './reverse-diagnostics.js';
import { computeRetryDelayMs, parseRetryAfterMs } from './retry-policy.js';

export async function waitForGroupBackoff(runner, item) {
  const groupBackoffWaitMs = runner.services.groupBackoff.getWaitMs(item.url);
  if (groupBackoffWaitMs > 0) {
    await runner.events.emit('page.delayed', {
      url: item.url,
      delayMs: groupBackoffWaitMs,
      reason: 'group-backoff',
      groupBy: runner.services.groupBackoff.config.groupBy,
    });
    await sleep(groupBackoffWaitMs);
  }
}

export async function applyAfterResponseHooks(runner, { request, response, item, attempt }) {
  const afterResponseResult = await runner.hooks.plugins.runHook('afterResponse', {
    request,
    response,
    item,
    runner,
    attempt,
    page: response?._page ?? null,
  });

  if (afterResponseResult?.reverseChallenge) {
    response.challenge = {
      ...(response.challenge ?? {}),
      ...afterResponseResult.reverseChallenge,
    };
  }
  if (afterResponseResult?.signerAsset) {
    response.signerAsset = afterResponseResult.signerAsset;
  }

  return response;
}

export async function handleDetectedChallenge(runner, { request, response, session, item, attemptsUsed, maxAttempts }) {
  if (response.challenge?.detected !== true) {
    return false;
  }

  if (request.proxy && ['reportFailure', 'cooldown'].includes(response.challenge.proxyAction ?? 'reportFailure')) {
    await runner.services.proxyPool.reportFailure(request.proxy, {
      message: `challenge detected: ${response.challenge.type ?? 'unknown'}`,
      proxyPool: runner.config.workflow.proxyPool,
    });
  }

  if (session?.id && session?._pooled && runner.services.sessionPool && ['reportFailure', 'retire'].includes(response.challenge.sessionAction ?? 'reportFailure')) {
    await runner.services.sessionPool.reportFailure(session.id, {
      message: `challenge detected: ${response.challenge.type ?? 'unknown'}`,
    });
  }

  if (response.challenge.shouldRetry && attemptsUsed < maxAttempts) {
    const delayMs = Number(runner.config.workflow.reverse?.challenge?.retryDelayMs ?? 1000);
    await runner.events.emitRetryAttempt({
      url: item.url,
      status: response.status,
      attempt: attemptsUsed,
      nextAttempt: attemptsUsed + 1,
      delayMs,
      proxyServer: request.proxy?.server ?? null,
      reason: 'challenge',
      attribution: response.challenge.attribution ?? 'challenge',
    });
    return true;
  }

  return false;
}

export async function reportSuccessfulFetchAttempt(runner, { mode, item, request, response, session, attemptStartedAtMs, requestSpan, attemptsUsed }) {
  runner.services.rateLimiter?.report(item.url, {
    durationMs: Date.now() - attemptStartedAtMs,
    ok: response.ok,
    status: response.status,
  });
  runner.services.observability?.meter?.incrementCounter?.('page_requests_total', 1, {
    mode,
    status: String(response.status),
  });
  runner.services.observability?.meter?.observeHistogram?.('page_request_duration_seconds', (Date.now() - attemptStartedAtMs) / 1000, {
    mode,
    status: String(response.status),
  });
  requestSpan?.setAttribute('http.status_code', response.status);
  requestSpan?.setAttribute('crawl.final_url', response.finalUrl);
  requestSpan?.addEvent('fetch.completed', {
    status: response.status,
    attempt: attemptsUsed,
  });

  await runner.hooks.plugins.runHook('afterFetch', {
    request,
    response,
    item,
    runner,
    attempt: attemptsUsed,
  });

  if (request.proxy) {
    if (runner.policy.shouldRetryStatus(response.status) && attemptsUsed < (runner.config.workflow.retry?.attempts ?? 1)) {
      await runner.services.proxyPool.reportFailure(request.proxy, {
        message: `retryable status ${response.status}`,
        proxyPool: runner.config.workflow.proxyPool,
      });
    } else {
      await runner.services.proxyPool.reportSuccess(request.proxy);
    }
  }

  if (session?.id && session?._pooled && runner.services.sessionPool) {
    if (runner.policy.shouldRetryStatus(response.status) && attemptsUsed < (runner.config.workflow.retry?.attempts ?? 1)) {
      await runner.services.sessionPool.reportFailure(session.id, {
        message: `retryable status ${response.status}`,
      });
    } else {
      await runner.services.sessionPool.reportSuccess(session.id);
    }
  }
}

export async function handleRetryableResponse(runner, { item, request, response, attemptsUsed, maxAttempts }) {
  const responseGroupBackoff = runner.policy.shouldGroupBackoffStatus(response.status)
    ? runner.services.groupBackoff.noteFailure(item.url, {
        status: response.status,
        retryAfterMs: parseRetryAfterMs(response.headers?.['retry-after'] ?? response.headers?.['Retry-After']),
      })
    : { delayMs: 0 };

  if (runner.policy.shouldRetryStatus(response.status) && attemptsUsed < maxAttempts) {
    const retryDelayMs = computeRetryDelayMs({
      attempt: attemptsUsed,
      response,
      retry: runner.config.workflow.retry,
    });
    const groupDelayMs = responseGroupBackoff.delayMs;
    const delayMs = Math.max(retryDelayMs, groupDelayMs);
    await runner.events.emitRetryAttempt({
      url: item.url,
      status: response.status,
      attempt: attemptsUsed,
      nextAttempt: attemptsUsed + 1,
      delayMs,
      proxyServer: request.proxy?.server ?? null,
      groupBackoffDelayMs: groupDelayMs,
    });
    return true;
  }

  if (response.ok || !runner.policy.shouldGroupBackoffStatus(response.status)) {
    runner.services.groupBackoff.noteSuccess(item.url);
  }

  return false;
}

export async function reportFailedFetchAttempt(runner, { mode, item, request, response, session, error, attemptStartedAtMs, requestSpan, attemptsUsed }) {
  try {
    await runner.hooks.plugins.runHook('onError', {
      request,
      item,
      runner,
      attempt: attemptsUsed,
      error,
      response,
      page: response?._page ?? null,
    });
  } catch (pluginError) {
    runner.hooks.logger.error('plugin onError hook failed', {
      url: item.url,
      error: pluginError?.message ?? String(pluginError),
    });
  }

  runner.services.rateLimiter?.report(item.url, {
    durationMs: Date.now() - attemptStartedAtMs,
    ok: false,
    status: Number(error?.status ?? 0),
  });
  runner.services.observability?.meter?.incrementCounter?.('page_failures_total', 1, {
    mode,
  });
  runner.services.observability?.meter?.observeHistogram?.('page_request_duration_seconds', (Date.now() - attemptStartedAtMs) / 1000, {
    mode,
    status: 'error',
  });
  requestSpan?.setStatus('error');
  requestSpan?.addEvent('fetch.failed', {
    attempt: attemptsUsed,
    error: error?.message ?? String(error),
  });

  if (request?.proxy) {
    await runner.services.proxyPool.reportFailure(request.proxy, {
      message: error?.message ?? String(error),
      proxyPool: runner.config.workflow.proxyPool,
    });
  }

  if (session?.id && session?._pooled && runner.services.sessionPool) {
    await runner.services.sessionPool.reportFailure(session.id, {
      message: error?.message ?? String(error),
    });
  }

  return runner.services.groupBackoff.noteFailure(item.url, {
    error: error?.message ?? String(error),
  });
}

export async function handleRetryableError(runner, { item, request, error, errorGroupBackoff, attemptsUsed, maxAttempts }) {
  if (attemptsUsed >= maxAttempts) {
    return false;
  }

  const retryDelayMs = computeRetryDelayMs({
    attempt: attemptsUsed,
    retry: runner.config.workflow.retry,
  });
  const groupDelayMs = errorGroupBackoff.delayMs;
  const delayMs = Math.max(retryDelayMs, groupDelayMs);
  await runner.events.emitRetryAttempt({
    url: item.url,
    attempt: attemptsUsed,
    nextAttempt: attemptsUsed + 1,
    error: error?.message ?? String(error),
    delayMs,
    proxyServer: request?.proxy?.server ?? null,
    groupBackoffDelayMs: groupDelayMs,
  });
  return true;
}

export function buildResultRecord(_runner, { item, request, response, mode, session, attemptsUsed, discovered, extracted }) {
  return {
    sequence: _runner.state.sequence + 1,
    url: item.url,
    finalUrl: response.finalUrl,
    mode,
    sessionId: session?.id ?? null,
    proxyServer: request.proxy?.server ?? null,
    proxyLabel: request.proxy?.label ?? null,
    attemptsUsed,
    depth: item.depth,
    parentUrl: item.parentUrl,
    uniqueKey: item.uniqueKey,
    status: response.status,
    notModified: response.notModified === true,
    cacheReused: response.cacheReused === true,
    cacheStatus: response.notModified === true ? 'validated-not-modified' : 'fetched',
    contentState: response.contentState ?? null,
    fetchedAt: response.fetchedAt,
    discoveredCount: discovered.length,
    debug: response.debug ?? null,
    replayState: response.replayState ?? null,
    challenge: response.challenge ?? null,
    signerAsset: response.signerAsset ?? null,
    messages: Array.isArray(response.messages) ? response.messages : null,
    identity: buildResultIdentitySnapshot({ request, response }),
    diagnostics: null,
    quality: null,
    extracted,
  };
}

export async function enrichResultRecord(runner, { request, response, result }) {
  result.quality = assessResultQuality({
    extracted: result.extracted,
    response,
    workflow: runner.config.workflow,
  });
  result.diagnostics = inspectResultDiagnostics({
    request,
    response,
    extracted: result.extracted,
    quality: result.quality,
  });

  const cacheEntry = await runner.services.httpCache.storeResponse(request, response);
  if (cacheEntry?.contentState) {
    result.contentState = cacheEntry.contentState;
  }
  if (cacheEntry) {
    result.cacheStatus = response.notModified === true ? 'validated-not-modified' : 'stored';
  }

  const extractionChange = await runner.services.httpCache.recordExtraction(request, result);
  if (extractionChange) {
    result.extractedChangeState = extractionChange.extractedChangeState;
    result.changedFields = extractionChange.changedFields;
    result.fieldChanges = extractionChange.fieldChanges;
    if (extractionChange.fieldChanges.length > 0) {
      runner.state.changeFeed.push({
        url: result.url,
        finalUrl: result.finalUrl,
        contentState: result.contentState,
        extractedChangeState: extractionChange.extractedChangeState,
        fieldChanges: extractionChange.fieldChanges,
        fetchedAt: result.fetchedAt,
      });
    }
  } else {
    result.extractedChangeState = null;
    result.changedFields = [];
    result.fieldChanges = [];
  }

  return result;
}

export async function finalizeProcessedResult(runner, { item, request, response, result, requestSpan, startedAtMs }) {
  runner.state.pagesFetched += 1;
  runner.state.resultCount += 1;
  runner.state.completed.push(result);
  runner.state.qualityTracker.add(result);

  await runner.services.sink.write({
    result,
    response,
  });

  await runner.hooks.plugins.runHook('afterExtract', {
    request,
    response,
    result,
    item,
    runner,
  });

  await runner.services.requestQueue.markHandled(item.uniqueKey, {
    finalUrl: result.finalUrl,
    responseStatus: result.status,
  });
  runner.services.observability?.meter?.incrementCounter?.('page_completed_total', 1, {
    mode: result.mode,
    status: String(result.status),
  });
  runner.services.observability?.meter?.setGauge?.('queue_pending', runner.services.requestQueue.summary().pendingCount ?? 0, {
    workflow: runner.config.workflow.name,
  });
  requestSpan?.end();
  runner.services.observability?.tracer?.endSpan?.(requestSpan);
  runner.services.autoscaler.report({
    durationMs: Date.now() - startedAtMs,
    ok: true,
  });
}

export function buildBrowserFetchHooks(runner, { request, item }) {
  return {
    beforeNavigation: async ({ page, attempt }) => {
      await runner.hooks.plugins.runHook('beforeNavigation', {
        request,
        item,
        runner,
        attempt,
        page,
      });
    },
    afterNavigation: async ({ page, response, attempt }) => {
      await runner.hooks.plugins.runHook('afterNavigation', {
        request,
        response,
        item,
        runner,
        attempt,
        page,
      });
    },
  };
}

export async function executeFetchAttempt(runner, { mode, request, item }) {
  const protocol = (() => {
    try {
      return new URL(request.url).protocol;
    } catch {
      return null;
    }
  })();

  if (protocol === 'ws:' || protocol === 'wss:') {
    return fetchWebSocketResponse(request, {
      ...(runner.config.workflow.websocket ?? {}),
      ...(request.websocket ?? {}),
    });
  }

  if (request.grpc?.enabled === true || (request.grpc?.service && request.grpc?.method)) {
    return fetchGrpcResponse(request, runner.config.workflow.grpc ?? {});
  }

  if (mode === 'browser') {
    return fetchWithBrowser(request, runner.config.workflow.browser, {
      sessionStore: runner.fetch.sessionStore,
      reverseEngine: runner.fetch.reverseEngine,
      hooks: buildBrowserFetchHooks(runner, { request, item }),
    });
  }

  if (mode === 'cheerio') {
    return fetchWithCheerio(request, { sessionStore: runner.fetch.sessionStore });
  }

  return fetchWithHttp(request, {
    sessionStore: runner.fetch.sessionStore,
    reverseEngine: runner.fetch.reverseEngine,
  });
}
