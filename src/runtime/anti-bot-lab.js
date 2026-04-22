import { readJson, writeJson } from '../utils/fs.js';

const DEGRADED_RE = /(enable javascript|access denied|unusual traffic|robot check|temporarily unavailable|请稍后再试|访问过于频繁|安全验证)/i;

export class AntiBotLab {
  constructor({ fingerprintTemplates = [], challengeSamples = [], experiments = [], path = null } = {}) {
    this.path = path;
    this.fingerprintTemplates = [...fingerprintTemplates];
    this.challengeSamples = [...challengeSamples];
    this.experiments = [...experiments];
    this.initPromise = null;
    this.persistPromise = Promise.resolve();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.path) return;
        try {
          const loaded = await readJson(this.path);
          this.fingerprintTemplates = Array.isArray(loaded?.fingerprintTemplates) ? loaded.fingerprintTemplates : [];
          this.challengeSamples = Array.isArray(loaded?.challengeSamples) ? loaded.challengeSamples : [];
          this.experiments = Array.isArray(loaded?.experiments) ? loaded.experiments : [];
        } catch {
          this.fingerprintTemplates = [];
          this.challengeSamples = [];
          this.experiments = [];
        }
      })();
    }
    await this.initPromise;
    return this;
  }

  snapshot() {
    return {
      version: 1,
      fingerprintTemplates: [...this.fingerprintTemplates],
      challengeSamples: [...this.challengeSamples],
      experiments: [...this.experiments],
    };
  }

  async persist() {
    if (!this.path) return;
    await writeJson(this.path, this.snapshot());
  }

  safePersist() {
    this.persistPromise = this.persistPromise
      .catch(() => {})
      .then(() => this.persist())
      .catch(() => {});
  }

  async flush() {
    await this.persistPromise;
  }

  addFingerprintTemplate(template) {
    this.fingerprintTemplates.push({ version: template.version ?? String(this.fingerprintTemplates.length + 1), ...template });
    this.safePersist();
    return this;
  }

  addChallengeSample(sample) {
    this.challengeSamples.push({ capturedAt: new Date().toISOString(), ...sample });
    this.safePersist();
    return this;
  }

  buildExperimentMatrix({ siteId, proxies = [], identities = [], browsers = [] } = {}) {
    const matrix = [];
    for (const proxy of proxies.length ? proxies : [null]) {
      for (const identity of identities.length ? identities : [null]) {
        for (const browser of browsers.length ? browsers : [null]) {
          matrix.push({
            id: `${siteId ?? 'site'}-${matrix.length + 1}`,
            siteId: siteId ?? null,
            proxy,
            identity,
            browser,
            fingerprintTemplate: this.fingerprintTemplates.find((template) => template.siteId === siteId) ?? null,
          });
        }
      }
    }
    return matrix;
  }

  recordExperiment(result) {
    const normalized = {
      recordedAt: new Date().toISOString(),
      success: Boolean(result.success),
      degraded: detectDegradedPage(result).detected,
      ...result,
    };
    this.experiments.push(normalized);
    this.safePersist();
    return normalized;
  }

  successRates() {
    const bySite = new Map();
    for (const result of this.experiments) {
      const key = result.siteId ?? 'default';
      if (!bySite.has(key)) bySite.set(key, { siteId: key, total: 0, success: 0, degraded: 0 });
      const row = bySite.get(key);
      row.total += 1;
      if (result.success) row.success += 1;
      if (result.degraded) row.degraded += 1;
    }
    return [...bySite.values()].map((row) => ({
      ...row,
      successRate: row.total ? row.success / row.total : 0,
      degradedRate: row.total ? row.degraded / row.total : 0,
    }));
  }
}

export function detectDegradedPage(response = {}) {
  const text = [response.title, response.body, response.html, response.text].filter(Boolean).join('\n');
  const status = Number(response.status ?? 200);
  const reasons = [];
  if ([403, 429, 503].includes(status)) reasons.push(`status:${status}`);
  if (DEGRADED_RE.test(text)) reasons.push('degraded-copy');
  if (Number(response.bodyLength ?? text.length) < Number(response.expectedMinLength ?? 0)) reasons.push('short-body');
  return {
    detected: reasons.length > 0,
    reasons,
  };
}
