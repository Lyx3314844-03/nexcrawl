function ratio(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return current / previous;
}

function percentDelta(current, previous) {
  if (!Number.isFinite(previous) || previous === 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function getDominantType(entries = []) {
  return entries[0]?.type ?? null;
}

function compareFieldCoverage(current = {}, previous = {}) {
  const fields = new Set([...Object.keys(current), ...Object.keys(previous)]);
  const deltas = [];

  for (const field of fields) {
    const currentCoverage = Number(current[field] ?? 0);
    const previousCoverage = Number(previous[field] ?? 0);
    deltas.push({
      field,
      current: currentCoverage,
      previous: previousCoverage,
      delta: currentCoverage - previousCoverage,
    });
  }

  return deltas.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta));
}

function compareFieldTypes(current = {}, previous = {}) {
  const fields = new Set([...Object.keys(current), ...Object.keys(previous)]);
  const changes = [];

  for (const field of fields) {
    const currentType = getDominantType(current[field]);
    const previousType = getDominantType(previous[field]);
    if (currentType && previousType && currentType !== previousType) {
      changes.push({
        field,
        previous: previousType,
        current: currentType,
      });
    }
  }

  return changes;
}

export function analyzeBaseline({ currentSummary, previousSummary } = {}) {
  if (!previousSummary) {
    return {
      available: false,
      previousJobId: null,
      previousFinishedAt: null,
      deltas: {},
      alerts: [],
    };
  }

  const currentQuality = currentSummary?.quality ?? {};
  const previousQuality = previousSummary?.quality ?? {};
  const currentStructure = currentQuality.structure ?? {};
  const previousStructure = previousQuality.structure ?? {};
  const currentSchema = currentQuality.schema ?? {};
  const previousSchema = previousQuality.schema ?? {};
  const currentWaf = currentQuality.waf ?? {};
  const previousWaf = previousQuality.waf ?? {};

  const deltas = {
    pagesFetched: {
      current: currentSummary.pagesFetched ?? 0,
      previous: previousSummary.pagesFetched ?? 0,
      percent: percentDelta(currentSummary.pagesFetched ?? 0, previousSummary.pagesFetched ?? 0),
    },
    resultCount: {
      current: currentSummary.resultCount ?? 0,
      previous: previousSummary.resultCount ?? 0,
      percent: percentDelta(currentSummary.resultCount ?? 0, previousSummary.resultCount ?? 0),
    },
    failureCount: {
      current: currentSummary.failureCount ?? 0,
      previous: previousSummary.failureCount ?? 0,
      delta: (currentSummary.failureCount ?? 0) - (previousSummary.failureCount ?? 0),
      percent: percentDelta(currentSummary.failureCount ?? 0, previousSummary.failureCount ?? 0),
    },
    changedCount: {
      current: currentSummary.httpCache?.changedCount ?? 0,
      previous: previousSummary.httpCache?.changedCount ?? 0,
      delta: (currentSummary.httpCache?.changedCount ?? 0) - (previousSummary.httpCache?.changedCount ?? 0),
    },
    unchangedCount: {
      current: currentSummary.httpCache?.unchangedCount ?? 0,
      previous: previousSummary.httpCache?.unchangedCount ?? 0,
      delta: (currentSummary.httpCache?.unchangedCount ?? 0) - (previousSummary.httpCache?.unchangedCount ?? 0),
    },
    healthScore: {
      current: currentQuality.healthScore ?? null,
      previous: previousQuality.healthScore ?? null,
      delta:
        Number.isFinite(currentQuality.healthScore) && Number.isFinite(previousQuality.healthScore)
          ? currentQuality.healthScore - previousQuality.healthScore
          : null,
    },
    invalidRecordCount: {
      current: currentSchema.invalidRecordCount ?? 0,
      previous: previousSchema.invalidRecordCount ?? 0,
      delta: (currentSchema.invalidRecordCount ?? 0) - (previousSchema.invalidRecordCount ?? 0),
    },
    wafDetectedCount: {
      current: currentWaf.detectedCount ?? 0,
      previous: previousWaf.detectedCount ?? 0,
      delta: (currentWaf.detectedCount ?? 0) - (previousWaf.detectedCount ?? 0),
    },
    challengedCount: {
      current: currentWaf.challengedCount ?? 0,
      previous: previousWaf.challengedCount ?? 0,
      delta: (currentWaf.challengedCount ?? 0) - (previousWaf.challengedCount ?? 0),
    },
    shapeVariantCount: {
      current: currentStructure.shapeVariantCount ?? 0,
      previous: previousStructure.shapeVariantCount ?? 0,
      delta: (currentStructure.shapeVariantCount ?? 0) - (previousStructure.shapeVariantCount ?? 0),
    },
    fieldCoverage: compareFieldCoverage(currentStructure.fieldCoverage ?? {}, previousStructure.fieldCoverage ?? {}),
    fieldTypes: compareFieldTypes(currentStructure.fieldTypes ?? {}, previousStructure.fieldTypes ?? {}),
  };

  const alerts = [];
  const resultRatio = ratio(deltas.resultCount.current, deltas.resultCount.previous);
  if (resultRatio !== null && resultRatio < 0.7) {
    alerts.push({
      type: 'result-count-drop',
      severity: 'warning',
      message: 'Result volume dropped materially versus the previous successful run.',
      ratio: resultRatio,
    });
  }

  const pageRatio = ratio(deltas.pagesFetched.current, deltas.pagesFetched.previous);
  if (pageRatio !== null && pageRatio < 0.7) {
    alerts.push({
      type: 'pages-fetched-drop',
      severity: 'warning',
      message: 'Fetched page volume dropped materially versus the previous successful run.',
      ratio: pageRatio,
    });
  }

  if ((deltas.failureCount.delta ?? 0) > 0) {
    alerts.push({
      type: 'failure-count-increase',
      severity: 'warning',
      message: 'Failure count increased versus the previous successful run.',
      delta: deltas.failureCount.delta,
    });
  }

  if ((deltas.changedCount.delta ?? 0) > 0) {
    alerts.push({
      type: 'content-change-increase',
      severity: 'info',
      message: 'More cached pages changed content versus the previous successful run.',
      delta: deltas.changedCount.delta,
    });
  }

  if ((deltas.healthScore.delta ?? 0) <= -15) {
    alerts.push({
      type: 'health-score-drop',
      severity: 'warning',
      message: 'Health score dropped materially versus the previous successful run.',
      delta: deltas.healthScore.delta,
    });
  }

  if ((deltas.invalidRecordCount.delta ?? 0) > 0) {
    alerts.push({
      type: 'schema-regression',
      severity: 'warning',
      message: 'More records violated the extraction schema than in the previous successful run.',
      delta: deltas.invalidRecordCount.delta,
    });
  }

  if ((deltas.challengedCount.delta ?? 0) > 0) {
    alerts.push({
      type: 'waf-challenge-increase',
      severity: 'warning',
      message: 'More challenge-like responses were detected than in the previous successful run.',
      delta: deltas.challengedCount.delta,
    });
  }

  for (const entry of deltas.fieldCoverage.filter((item) => item.delta <= -0.4).slice(0, 10)) {
    alerts.push({
      type: 'field-coverage-drop',
      severity: 'warning',
      field: entry.field,
      message: `Field coverage for ${entry.field} dropped materially versus the previous successful run.`,
      delta: entry.delta,
    });
  }

  for (const change of deltas.fieldTypes.slice(0, 10)) {
    alerts.push({
      type: 'field-type-change',
      severity: 'warning',
      field: change.field,
      previous: change.previous,
      current: change.current,
      message: `Dominant extracted type for ${change.field} changed versus the previous successful run.`,
    });
  }

  return {
    available: true,
    previousJobId: previousSummary.jobId ?? null,
    previousFinishedAt: previousSummary.finishedAt ?? null,
    deltas,
    alerts,
  };
}
