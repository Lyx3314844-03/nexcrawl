function normalizeAutoscaleConfig(config = {}, maxConcurrency = 1) {
  const upperBound = Math.max(1, Number(config.maxConcurrency ?? maxConcurrency));
  const lowerBound = Math.min(upperBound, Math.max(1, Number(config.minConcurrency ?? 1)));

  return {
    enabled: config.enabled === true,
    minConcurrency: lowerBound,
    maxConcurrency: upperBound,
    scaleUpStep: Math.max(1, Number(config.scaleUpStep ?? 1)),
    scaleDownStep: Math.max(1, Number(config.scaleDownStep ?? 1)),
    targetLatencyMs: Math.max(100, Number(config.targetLatencyMs ?? 3000)),
    maxFailureRate: Math.min(1, Math.max(0, Number(config.maxFailureRate ?? 0.2))),
    sampleWindow: Math.max(5, Number(config.sampleWindow ?? 20)),
  };
}

export class AutoscaleController {
  constructor({ config = {}, maxConcurrency = 1 } = {}) {
    this.config = normalizeAutoscaleConfig(config, maxConcurrency);
    this.samples = [];
    this.current = this.config.enabled ? this.config.minConcurrency : this.config.maxConcurrency;
  }

  limit() {
    return this.current;
  }

  report(sample) {
    const normalized = {
      durationMs: Math.max(0, Number(sample.durationMs ?? 0)),
      ok: sample.ok !== false,
    };

    this.samples.push(normalized);
    if (this.samples.length > this.config.sampleWindow) {
      this.samples.shift();
    }

    if (!this.config.enabled) {
      return this.snapshot();
    }

    const averageLatency =
      this.samples.reduce((total, item) => total + item.durationMs, 0) / Math.max(1, this.samples.length);
    const failureRate =
      this.samples.filter((item) => !item.ok).length / Math.max(1, this.samples.length);

    if (failureRate > this.config.maxFailureRate || averageLatency > this.config.targetLatencyMs * 1.25) {
      this.current = Math.max(this.config.minConcurrency, this.current - this.config.scaleDownStep);
      return this.snapshot();
    }

    if (failureRate <= this.config.maxFailureRate / 2 && averageLatency < this.config.targetLatencyMs * 0.75) {
      this.current = Math.min(this.config.maxConcurrency, this.current + this.config.scaleUpStep);
    }

    return this.snapshot();
  }

  snapshot() {
    const averageLatency =
      this.samples.reduce((total, item) => total + item.durationMs, 0) / Math.max(1, this.samples.length);
    const failureRate =
      this.samples.filter((item) => !item.ok).length / Math.max(1, this.samples.length);

    return {
      enabled: this.config.enabled,
      currentConcurrency: this.current,
      minConcurrency: this.config.minConcurrency,
      maxConcurrency: this.config.maxConcurrency,
      sampleCount: this.samples.length,
      averageLatencyMs: Math.round(averageLatency),
      failureRate,
    };
  }
}
