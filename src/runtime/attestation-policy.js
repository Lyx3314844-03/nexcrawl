const ATTESTATION_RE = /(play integrity|safetynet|devicecheck|app attest|attestation|device reputation|设备信誉|完整性校验)/i;

export function detectAttestationGate(signal = {}) {
  const text = [signal.error, signal.body, signal.html, signal.message, signal.reason]
    .filter((value) => typeof value === 'string')
    .join('\n');
  const reasons = [];
  if (ATTESTATION_RE.test(text)) reasons.push('attestation-copy');
  if ([401, 403, 423, 429].includes(Number(signal.status))) reasons.push(`status:${signal.status}`);
  if (signal.headers?.['x-play-integrity'] || signal.headers?.['x-safetynet']) reasons.push('attestation-header');
  return {
    detected: reasons.length > 0,
    reasons,
  };
}

export function buildAttestationCompliancePlan(signal = {}, options = {}) {
  const detection = detectAttestationGate(signal);
  return {
    kind: 'attestation-compliance-plan',
    detected: detection.detected,
    reasons: detection.reasons,
    policy: 'do-not-bypass',
    allowedActions: detection.detected
      ? ['stop-automation', 'quarantine-account-or-device', 'request-owner-approved-test-device', 'manual-review']
      : ['continue'],
    blockedActions: ['spoof-attestation', 'bypass-device-reputation', 'forge-integrity-token'],
    escalation: detection.detected
      ? {
          required: true,
          owner: options.owner ?? 'security-or-platform-owner',
          message: 'Target requires platform/device attestation. Use owner-approved devices and credentials; do not bypass integrity checks.',
        }
      : { required: false },
  };
}

