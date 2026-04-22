function selectorAlternatives(selector = '') {
  const value = String(selector ?? '');
  const alternatives = [];
  const id = value.match(/^#([A-Za-z0-9_-]+)$/)?.[1];
  const testId = value.match(/\[data-testid=["']?([^"'\]]+)/)?.[1];
  if (id) alternatives.push(`[id="${id}"]`, `[data-testid="${id}"]`, `[name="${id}"]`);
  if (testId) alternatives.push(`[data-test="${testId}"]`, `[aria-label="${testId}"]`);
  if (/button|submit|login|sign/i.test(value)) alternatives.push('button[type="submit"]', 'input[type="submit"]');
  return [...new Set(alternatives.filter((entry) => entry !== value))];
}

export function generalizeRecordingSteps(steps = []) {
  return steps.map((step) => {
    if (step.type === 'type' && /password|pass|pwd/i.test(step.selector ?? step.name ?? '')) {
      return { ...step, value: '{{credentials.password}}', secret: true };
    }
    if (step.type === 'type' && /(user|email|login|account)/i.test(step.selector ?? step.name ?? '')) {
      return { ...step, value: '{{credentials.username}}' };
    }
    return { ...step };
  });
}

export function buildSelectorRepairPlan(failure = {}) {
  const selector = failure.selector ?? failure.step?.selector;
  return {
    kind: 'selector-repair-plan',
    selector,
    alternatives: selectorAlternatives(selector),
    evidence: failure.evidence ?? [],
  };
}

export function learnLoginSuccessPredicate(observations = []) {
  const successes = observations.filter((entry) => entry.success === true);
  const explicitSelector = successes.find((entry) => entry.selector)?.selector ?? null;
  const selector = explicitSelector
    ?? (successes.find((entry) => /logout|account|dashboard/i.test(entry.html ?? '')) ? 'body' : null);
  const finalUrlPattern = successes.find((entry) => entry.finalUrl && !/login|signin|auth/i.test(entry.finalUrl))?.finalUrl
    ?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    ?.replace(/\/$/, '');
  return {
    kind: 'login-success-predicate',
    selector,
    finalUrlPattern,
    cookieRequired: successes.some((entry) => (entry.cookies ?? []).length > 0),
    tokenRequired: successes.some((entry) => Object.keys(entry.tokens ?? {}).length > 0),
  };
}

export function buildAutoPatchPlan({ recording = {}, failure = {}, observations = [] } = {}) {
  const generalizedSteps = generalizeRecordingSteps(recording.steps ?? []);
  const selectorRepair = failure.selector || failure.step?.selector ? buildSelectorRepairPlan(failure) : null;
  const successPredicate = learnLoginSuccessPredicate(observations);
  return {
    kind: 'self-healing-patch-plan',
    generalizedSteps,
    selectorRepair,
    successPredicate,
    patches: [
      selectorRepair ? { op: 'replace-selector', selector: selectorRepair.selector, candidates: selectorRepair.alternatives } : null,
      successPredicate.selector || successPredicate.finalUrlPattern ? { op: 'update-success-predicate', predicate: successPredicate } : null,
    ].filter(Boolean),
  };
}
