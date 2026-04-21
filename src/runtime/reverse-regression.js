import { evaluateSignerArtifact } from './reverse-signer-runtime.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function lowerText(value) {
  return String(value ?? '').toLowerCase();
}

function matchesPattern(value, pattern) {
  if (!pattern) {
    return true;
  }

  const text = String(value ?? '');
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return text.includes(String(pattern));
  }
}

function hasHeader(headers = {}, name) {
  const target = String(name ?? '').toLowerCase();
  if (!target) {
    return false;
  }

  return Object.keys(headers ?? {}).some((headerName) => lowerText(headerName) === target);
}

function matchesExpectation(actual, testCase) {
  if (testCase.exists !== undefined) {
    return testCase.exists ? actual !== null && actual !== undefined : actual === null || actual === undefined;
  }

  if (testCase.equals !== undefined) {
    return actual === testCase.equals;
  }

  if (testCase.matches) {
    try {
      return new RegExp(testCase.matches).test(String(actual ?? ''));
    } catch {
      return String(actual ?? '').includes(String(testCase.matches));
    }
  }

  return true;
}

function buildIdentityExpectation(workflow = {}) {
  const identity = workflow.identity ?? {};
  return {
    userAgent: identity.userAgent ?? null,
    acceptLanguage: identity.acceptLanguage ?? null,
    locale: identity.locale ?? null,
    timezoneId: identity.timezoneId ?? null,
    bundleId: identity.bundleId ?? null,
    tlsProfile: identity.tlsProfile ?? null,
    h2Profile: identity.h2Profile && typeof identity.h2Profile === 'object'
      ? identity.h2Profile.name ?? identity.h2Profile.profile ?? 'custom'
      : identity.h2Profile ?? null,
  };
}

async function runSignerRegression({ workflow, assetStore }) {
  if (workflow.signer?.enabled !== true || workflow.signer?.regression?.enabled !== true) {
    return null;
  }

  const assetId = workflow.signer.assetId ?? workflow.name;
  const artifact = await assetStore.getSignerArtifact(assetId);
  if (!artifact) {
    return {
      name: 'signer',
      passed: false,
      reason: `signer artifact missing: ${assetId}`,
      cases: [],
    };
  }

  const cases = [];
  for (const testCase of toArray(workflow.signer.regression?.cases)) {
    let actual = null;
    let error = null;
    try {
      actual = await evaluateSignerArtifact(artifact, testCase.params ?? {}, {
        timeoutMs: workflow.signer?.timeoutMs ?? 2000,
      });
    } catch (cause) {
      error = cause?.message ?? String(cause);
    }

    cases.push({
      name: testCase.name,
      passed: !error && matchesExpectation(actual, testCase),
      actual,
      error,
      expected: {
        equals: testCase.equals,
        matches: testCase.matches,
        exists: testCase.exists,
      },
    });
  }

  return {
    name: 'signer',
    passed: cases.every((entry) => entry.passed),
    cases,
  };
}

function runRequestContractRegression({ workflow, results }) {
  const contracts = toArray(workflow.reverse?.regression?.requestContracts);
  if (contracts.length === 0) {
    return null;
  }

  const cases = contracts.map((contract) => {
    const expectedMinMatches = Math.max(1, Number(contract.minMatches ?? 1) || 1);
    const expectedMaxMatches = contract.maxMatches === undefined || contract.maxMatches === null
      ? null
      : Math.max(0, Number(contract.maxMatches) || 0);
    const matchedRequests = [];

    for (const result of results) {
      for (const request of toArray(result.debug?.requests)) {
        const requestHeaders = request.requestHeaders ?? {};
        const responseHeaders = request.responseHeaders ?? {};
        const requestBody = request.requestBody?.text ?? '';
        const responseBody = request.responseBody?.text ?? '';
        const matches =
          matchesPattern(request.url, contract.urlPattern)
          && matchesPattern(request.url, contract.finalUrlPattern)
          && (!contract.method || String(request.method ?? '').toUpperCase() === String(contract.method).toUpperCase())
          && (!contract.transport || String(request.transport ?? '').toLowerCase() === String(contract.transport).toLowerCase())
          && (contract.status === undefined || Number(request.status ?? 0) === Number(contract.status))
          && toArray(contract.requestHeaderNames).every((headerName) => hasHeader(requestHeaders, headerName))
          && toArray(contract.responseHeaderNames).every((headerName) => hasHeader(responseHeaders, headerName))
          && matchesPattern(requestBody, contract.requestBodyPattern)
          && matchesPattern(responseBody, contract.responseBodyPattern);

        if (!matches) {
          continue;
        }

        matchedRequests.push({
          pageUrl: result.finalUrl ?? result.url ?? null,
          requestId: request.requestId ?? null,
          url: request.url ?? null,
          method: request.method ?? null,
          transport: request.transport ?? null,
          status: request.status ?? null,
        });
      }
    }

    const withinMax = expectedMaxMatches === null || matchedRequests.length <= expectedMaxMatches;
    const passed = matchedRequests.length >= expectedMinMatches && withinMax;

    return {
      name: contract.name,
      passed,
      expected: {
        minMatches: expectedMinMatches,
        maxMatches: expectedMaxMatches,
        method: contract.method ?? null,
        transport: contract.transport ?? null,
        status: contract.status ?? null,
        urlPattern: contract.urlPattern ?? null,
        finalUrlPattern: contract.finalUrlPattern ?? null,
        requestHeaderNames: toArray(contract.requestHeaderNames),
        responseHeaderNames: toArray(contract.responseHeaderNames),
        requestBodyPattern: contract.requestBodyPattern ?? null,
        responseBodyPattern: contract.responseBodyPattern ?? null,
      },
      matchCount: matchedRequests.length,
      matches: matchedRequests,
    };
  });

  return {
    name: 'requestContracts',
    passed: cases.every((entry) => entry.passed),
    cases,
  };
}

function runChallengeRegression({ workflow, results }) {
  if (workflow.reverse?.regression?.challenge?.enabled !== true) {
    return null;
  }

  const detected = results.filter((entry) => entry.challenge?.detected === true).length;
  const solved = results.filter((entry) => entry.challenge?.solved === true).length;
  const requireSolved = workflow.reverse.regression.challenge.requireSolved === true;
  const maxDetected = Number(workflow.reverse.regression.challenge.maxDetected ?? 0);
  const passed = detected <= maxDetected && (!requireSolved || solved === detected);

  return {
    name: 'challenge',
    passed,
    metrics: {
      detected,
      solved,
      maxDetected,
      requireSolved,
    },
  };
}

function runIdentityRegression({ workflow, results }) {
  if (workflow.reverse?.regression?.identity?.enabled !== true) {
    return null;
  }

  const expected = buildIdentityExpectation(workflow);
  const allowDriftFields = new Set(workflow.reverse.regression.identity.allowDriftFields ?? []);
  const drifts = [];

  for (const result of results) {
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (allowDriftFields.has(field) || expectedValue === null || expectedValue === undefined) {
        continue;
      }

      const actualValue = result.identity?.[field] ?? null;
      if (actualValue !== expectedValue) {
        drifts.push({
          url: result.finalUrl ?? result.url,
          field,
          expected: expectedValue,
          actual: actualValue,
        });
      }
    }
  }

  return {
    name: 'identity',
    passed: drifts.length === 0,
    drifts,
  };
}

function runAntiBotRegression({ workflow, summary }) {
  if (workflow.reverse?.regression?.antiBot?.enabled !== true) {
    return null;
  }

  const maxChallengeLikely = Number(workflow.reverse.regression.antiBot.maxChallengeLikely ?? 0);
  const maxBlocked = Number(workflow.reverse.regression.antiBot.maxBlocked ?? 0);
  const challengeLikely = Number(summary.quality?.waf?.challengedCount ?? 0);
  const blocked = Number(summary.failureCount ?? 0);

  return {
    name: 'antiBot',
    passed: challengeLikely <= maxChallengeLikely && blocked <= maxBlocked,
    metrics: {
      challengeLikely,
      blocked,
      maxChallengeLikely,
      maxBlocked,
    },
  };
}

export async function runReverseRegressionSuite({ workflow, summary, results, assetStore }) {
  const suites = [];
  const signer = await runSignerRegression({ workflow, assetStore });
  const requestContracts = runRequestContractRegression({ workflow, results });
  const challenge = runChallengeRegression({ workflow, results });
  const identity = runIdentityRegression({ workflow, results });
  const antiBot = runAntiBotRegression({ workflow, summary });

  for (const entry of [signer, requestContracts, challenge, identity, antiBot]) {
    if (entry) {
      suites.push(entry);
    }
  }

  if (suites.length === 0) {
    return null;
  }

  return {
    passed: suites.every((entry) => entry.passed),
    suites,
  };
}
