function average(values = []) {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) {
    return null;
  }
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function percentFromAverage(current, mean) {
  if (!Number.isFinite(mean) || mean === 0) {
    return null;
  }
  return ((current - mean) / mean) * 100;
}

function summarizeWindow(previousSummaries = []) {
  return {
    pagesFetched: average(previousSummaries.map((entry) => entry.pagesFetched ?? null)),
    resultCount: average(previousSummaries.map((entry) => entry.resultCount ?? null)),
    failureCount: average(previousSummaries.map((entry) => entry.failureCount ?? null)),
    changedCount: average(previousSummaries.map((entry) => entry.httpCache?.changedCount ?? null)),
    unchangedCount: average(previousSummaries.map((entry) => entry.httpCache?.unchangedCount ?? null)),
    healthScore: average(previousSummaries.map((entry) => entry.quality?.healthScore ?? null)),
    invalidRecordCount: average(previousSummaries.map((entry) => entry.quality?.schema?.invalidRecordCount ?? null)),
    challengedCount: average(previousSummaries.map((entry) => entry.quality?.waf?.challengedCount ?? null)),
  };
}

export function analyzeTrends({ currentSummary, previousSummaries = [] } = {}) {
  if (!Array.isArray(previousSummaries) || previousSummaries.length === 0) {
    return {
      available: false,
      sampleCount: 0,
      windowJobIds: [],
      averages: {},
      deltas: {},
      alerts: [],
    };
  }

  const averages = summarizeWindow(previousSummaries);
  const deltas = {
    pagesFetched: {
      current: currentSummary.pagesFetched ?? 0,
      average: averages.pagesFetched,
      percent: percentFromAverage(currentSummary.pagesFetched ?? 0, averages.pagesFetched),
    },
    resultCount: {
      current: currentSummary.resultCount ?? 0,
      average: averages.resultCount,
      percent: percentFromAverage(currentSummary.resultCount ?? 0, averages.resultCount),
    },
    failureCount: {
      current: currentSummary.failureCount ?? 0,
      average: averages.failureCount,
      percent: percentFromAverage(currentSummary.failureCount ?? 0, averages.failureCount),
    },
    changedCount: {
      current: currentSummary.httpCache?.changedCount ?? 0,
      average: averages.changedCount,
      percent: percentFromAverage(currentSummary.httpCache?.changedCount ?? 0, averages.changedCount),
    },
    unchangedCount: {
      current: currentSummary.httpCache?.unchangedCount ?? 0,
      average: averages.unchangedCount,
      percent: percentFromAverage(currentSummary.httpCache?.unchangedCount ?? 0, averages.unchangedCount),
    },
    healthScore: {
      current: currentSummary.quality?.healthScore ?? null,
      average: averages.healthScore,
      delta:
        Number.isFinite(currentSummary.quality?.healthScore) && Number.isFinite(averages.healthScore)
          ? currentSummary.quality.healthScore - averages.healthScore
          : null,
    },
    invalidRecordCount: {
      current: currentSummary.quality?.schema?.invalidRecordCount ?? 0,
      average: averages.invalidRecordCount,
      delta:
        Number.isFinite(currentSummary.quality?.schema?.invalidRecordCount) && Number.isFinite(averages.invalidRecordCount)
          ? currentSummary.quality.schema.invalidRecordCount - averages.invalidRecordCount
          : null,
    },
    challengedCount: {
      current: currentSummary.quality?.waf?.challengedCount ?? 0,
      average: averages.challengedCount,
      delta:
        Number.isFinite(currentSummary.quality?.waf?.challengedCount) && Number.isFinite(averages.challengedCount)
          ? currentSummary.quality.waf.challengedCount - averages.challengedCount
          : null,
    },
  };

  const alerts = [];

  if (Number.isFinite(deltas.resultCount.percent) && deltas.resultCount.percent <= -30) {
    alerts.push({
      type: 'result-count-below-trend',
      severity: 'warning',
      message: 'Result volume is materially below the recent successful-run average.',
      percent: deltas.resultCount.percent,
    });
  }

  if (Number.isFinite(deltas.pagesFetched.percent) && deltas.pagesFetched.percent <= -30) {
    alerts.push({
      type: 'pages-fetched-below-trend',
      severity: 'warning',
      message: 'Fetched page volume is materially below the recent successful-run average.',
      percent: deltas.pagesFetched.percent,
    });
  }

  if (Number.isFinite(deltas.healthScore.delta) && deltas.healthScore.delta <= -15) {
    alerts.push({
      type: 'health-score-below-trend',
      severity: 'warning',
      message: 'Health score is materially below the recent successful-run average.',
      delta: deltas.healthScore.delta,
    });
  }

  if (Number.isFinite(deltas.failureCount.percent) && deltas.failureCount.percent >= 50) {
    alerts.push({
      type: 'failure-count-above-trend',
      severity: 'warning',
      message: 'Failure count is materially above the recent successful-run average.',
      percent: deltas.failureCount.percent,
    });
  } else if ((deltas.failureCount.current ?? 0) > 0 && (deltas.failureCount.average ?? 0) === 0) {
    alerts.push({
      type: 'failure-count-above-trend',
      severity: 'warning',
      message: 'Failure count is above the recent successful-run average, which was previously zero.',
      percent: null,
    });
  }

  if (Number.isFinite(deltas.changedCount.percent) && deltas.changedCount.percent >= 50) {
    alerts.push({
      type: 'content-change-above-trend',
      severity: 'info',
      message: 'Content changes are materially above the recent successful-run average.',
      percent: deltas.changedCount.percent,
    });
  }

  if (Number.isFinite(deltas.invalidRecordCount.delta) && deltas.invalidRecordCount.delta >= 1) {
    alerts.push({
      type: 'schema-invalid-above-trend',
      severity: 'warning',
      message: 'Schema validation failures are above the recent successful-run average.',
      delta: deltas.invalidRecordCount.delta,
    });
  }

  if (Number.isFinite(deltas.challengedCount.delta) && deltas.challengedCount.delta >= 1) {
    alerts.push({
      type: 'challenge-count-above-trend',
      severity: 'warning',
      message: 'Challenge-like responses are above the recent successful-run average.',
      delta: deltas.challengedCount.delta,
    });
  }

  return {
    available: true,
    sampleCount: previousSummaries.length,
    windowJobIds: previousSummaries.map((entry) => entry.jobId).filter(Boolean),
    averages,
    deltas,
    alerts,
  };
}
