import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: packageVersion } = require('../../package.json');

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';
export const OPENMETRICS_CONTENT_TYPE = 'application/openmetrics-text; version=1.0.0; charset=utf-8';

class Span {
  constructor(name, attributes = {}) {
    this.name = name;
    this.attributes = { ...attributes };
    this.events = [];
    this.status = { code: 'UNSET', message: '' };
    this.startTime = Date.now();
    this.endTime = null;
    this.durationMs = null;
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
    return this;
  }

  addEvent(name, attributes = {}) {
    this.events.push({
      name,
      attributes: { ...attributes },
      timestamp: Date.now(),
    });
    return this;
  }

  setStatus(code, message = '') {
    this.status = { code: String(code ?? 'UNSET').toUpperCase(), message };
    return this;
  }

  end() {
    if (this.endTime !== null) {
      return this;
    }
    this.endTime = Date.now();
    this.durationMs = Math.max(0, this.endTime - this.startTime);
    return this;
  }
}

class SimpleTracer {
  constructor(options = {}) {
    this.sampleRate = Number.isFinite(options.sampleRate) ? options.sampleRate : 1;
    this.otlpEndpoint = options.otlpEndpoint ?? null;
    this.spans = [];
  }

  startSpan(name, options = {}) {
    if (this.sampleRate <= 0) {
      return new Span(name, options.attributes ?? {});
    }
    const span = new Span(name, options.attributes ?? {});
    this.spans.push(span);
    return span;
  }

  endSpan(span) {
    span?.end?.();
    return span;
  }

  getSpans() {
    return [...this.spans];
  }

  getErrorSpans() {
    return this.spans.filter((span) => span.status.code === 'ERROR');
  }
}

class NoopTracer {
  startSpan(name, options = {}) {
    return new Span(name, options.attributes ?? {});
  }

  endSpan(span) {
    span?.end?.();
    return span;
  }

  getSpans() {
    return [];
  }

  getErrorSpans() {
    return [];
  }
}

function applyPrefix(prefix, name) {
  const trimmedPrefix = String(prefix ?? '').trim();
  const trimmedName = String(name ?? '').trim();
  if (!trimmedPrefix) {
    return trimmedName;
  }
  if (trimmedName.startsWith(trimmedPrefix)) {
    return trimmedName;
  }
  return `${trimmedPrefix}${trimmedName}`;
}

class SimpleMetrics {
  constructor({ prefix = '', defaultLabels = {} } = {}) {
    this.prefix = prefix;
    this.defaultLabels = { ...defaultLabels };
    this.counters = new Map();
    this.gauges = new Map();
    this.histograms = new Map();
    this.incrementCounter('omnicrawl_build_info', 1, { version: packageVersion });
  }

  incrementCounter(name, value = 1, labels = {}) {
    this.#recordScalar(this.counters, name, value, labels, (current, next) => current + next);
  }

  setGauge(name, value, labels = {}) {
    this.#recordScalar(this.gauges, name, value, labels, (_current, next) => next);
  }

  observeHistogram(name, value, labels = {}, buckets = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60]) {
    const metric = this.#ensureMetric(this.histograms, name, { buckets: [...buckets].sort((a, b) => a - b) });
    const normalizedLabels = this.#normalizedLabels(labels);
    const key = this.#labelKey(normalizedLabels);
    const entry = metric.series.get(key) ?? {
      labels: normalizedLabels,
      count: 0,
      sum: 0,
      buckets: new Map(metric.buckets.map((bucket) => [bucket, 0])),
    };

    entry.count += 1;
    entry.sum += value;
    for (const bucket of metric.buckets) {
      if (value <= bucket) {
        entry.buckets.set(bucket, entry.buckets.get(bucket) + 1);
      }
    }
    metric.series.set(key, entry);
  }

  metrics() {
    return this.toPrometheusFormat();
  }

  toPrometheusFormat() {
    const lines = [];
    this.#appendScalar(lines, this.counters, 'counter');
    this.#appendScalar(lines, this.gauges, 'gauge');

    for (const metric of this.histograms.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} histogram`);
      for (const entry of metric.series.values()) {
        const baseLabels = this.#renderLabels(entry.labels);
        for (const [bucket, count] of entry.buckets.entries()) {
          lines.push(`${metric.name}_bucket${this.#mergeLabels(baseLabels, `le="${bucket}"`)} ${count}`);
        }
        lines.push(`${metric.name}_bucket${this.#mergeLabels(baseLabels, 'le="+Inf"')} ${entry.count}`);
        lines.push(`${metric.name}_sum${baseLabels} ${entry.sum}`);
        lines.push(`${metric.name}_count${baseLabels} ${entry.count}`);
      }
    }

    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
  }

  summary() {
    return {
      counters: [...this.counters.values()].map((metric) => this.#metricSummary(metric)),
      gauges: [...this.gauges.values()].map((metric) => this.#metricSummary(metric)),
      histograms: [...this.histograms.values()].map((metric) => this.#metricSummary(metric, true)),
    };
  }

  #metricSummary(metric, histogram = false) {
    return {
      name: metric.name,
      seriesCount: metric.series.size,
      labels: [...metric.labelNames],
      sampleCount: [...metric.series.values()].reduce((total, entry) => total + (histogram ? entry.count : 1), 0),
    };
  }

  #ensureMetric(store, name, extra = {}) {
    const normalizedName = applyPrefix(this.prefix, name);
    if (!store.has(normalizedName)) {
      store.set(normalizedName, {
        name: normalizedName,
        help: `${normalizedName} metric`,
        labelNames: new Set(),
        series: new Map(),
        ...extra,
      });
    }
    return store.get(normalizedName);
  }

  #recordScalar(store, name, value, labels, reducer) {
    const metric = this.#ensureMetric(store, name);
    const normalizedLabels = this.#normalizedLabels(labels);
    const key = this.#labelKey(normalizedLabels);
    for (const labelName of Object.keys(normalizedLabels)) {
      metric.labelNames.add(labelName);
    }
    const entry = metric.series.get(key) ?? { labels: normalizedLabels, value: 0 };
    entry.value = reducer(Number(entry.value ?? 0), Number(value ?? 0));
    metric.series.set(key, entry);
  }

  #appendScalar(lines, store, type) {
    for (const metric of store.values()) {
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${type}`);
      for (const entry of metric.series.values()) {
        lines.push(`${metric.name}${this.#renderLabels(entry.labels)} ${entry.value}`);
      }
    }
  }

  #normalizedLabels(labels = {}) {
    return {
      ...this.defaultLabels,
      ...(labels ?? {}),
    };
  }

  #labelKey(labels) {
    return Object.entries(labels ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join(',');
  }

  #renderLabels(labels) {
    const rendered = Object.entries(labels ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`)
      .join(',');
    return rendered ? `{${rendered}}` : '';
  }

  #mergeLabels(baseLabels, extraLabel) {
    if (!baseLabels) {
      return `{${extraLabel}}`;
    }
    return `{${baseLabels.slice(1, -1)},${extraLabel}}`;
  }
}

class NoopMeter {
  incrementCounter() {}
  setGauge() {}
  observeHistogram() {}
  metrics() { return ''; }
  toPrometheusFormat() { return ''; }
  summary() { return { counters: [], gauges: [], histograms: [] }; }
}

class SimpleRegistry {
  static PROMETHEUS_CONTENT_TYPE = PROMETHEUS_CONTENT_TYPE;

  static OPENMETRICS_CONTENT_TYPE = OPENMETRICS_CONTENT_TYPE;

  constructor(meter, contentType = PROMETHEUS_CONTENT_TYPE) {
    this.meter = meter;
    this.contentType = contentType;
  }

  setContentType(contentType) {
    this.contentType = contentType === OPENMETRICS_CONTENT_TYPE
      ? OPENMETRICS_CONTENT_TYPE
      : PROMETHEUS_CONTENT_TYPE;
  }

  async metrics() {
    const base = this.meter?.toPrometheusFormat?.() ?? '';
    if (this.contentType === OPENMETRICS_CONTENT_TYPE) {
      return `${base}# EOF\n`;
    }
    return base;
  }
}

class NoopRegistry {
  constructor() {
    this.contentType = PROMETHEUS_CONTENT_TYPE;
  }

  setContentType(contentType) {
    this.contentType = contentType === OPENMETRICS_CONTENT_TYPE
      ? OPENMETRICS_CONTENT_TYPE
      : PROMETHEUS_CONTENT_TYPE;
  }

  async metrics() {
    return '';
  }
}

let currentObservability = null;

function normalizeObservabilityConfig(config = {}) {
  const source = config.workflow && typeof config.workflow === 'object'
    ? config.workflow
    : config;

  const tracingSource = source.tracing ?? {};
  const metricsSource = source.metrics ?? {};

  return {
    tracing: {
      enabled: tracingSource.enabled !== false,
      serviceName: tracingSource.serviceName ?? source.serviceName ?? 'omnicrawl',
      otlpEndpoint: tracingSource.endpoint ?? tracingSource.otlpEndpoint ?? source.otlpEndpoint ?? null,
      sampleRate: Number.isFinite(tracingSource.sampleRate) ? tracingSource.sampleRate : 1,
    },
    metrics: {
      enabled: metricsSource.enabled !== false,
      port: metricsSource.port ?? source.prometheusPort ?? Number.parseInt(process.env.PROMETHEUS_PORT ?? '9464', 10),
      prefix: metricsSource.prefix ?? '',
      defaultLabels: { ...(metricsSource.defaultLabels ?? {}) },
      contentType: metricsSource.contentType === OPENMETRICS_CONTENT_TYPE
        ? OPENMETRICS_CONTENT_TYPE
        : PROMETHEUS_CONTENT_TYPE,
    },
  };
}

export function setupObservability(config = {}) {
  const normalized = normalizeObservabilityConfig(config);
  const tracer = normalized.tracing.enabled
    ? new SimpleTracer({
        sampleRate: normalized.tracing.sampleRate,
        otlpEndpoint: normalized.tracing.otlpEndpoint,
      })
    : new NoopTracer();
  const meter = normalized.metrics.enabled
    ? new SimpleMetrics({
        prefix: normalized.metrics.prefix,
        defaultLabels: normalized.metrics.defaultLabels,
      })
    : new NoopMeter();
  const promRegistry = normalized.metrics.enabled
    ? new SimpleRegistry(meter, normalized.metrics.contentType)
    : new NoopRegistry();

  currentObservability = {
    config: normalized,
    tracer,
    meter,
    metrics: meter,
    promClient: null,
    promRegistry,
  };

  return currentObservability;
}

export function getTracer() {
  return currentObservability?.tracer ?? new NoopTracer();
}

export function getMetrics() {
  return currentObservability?.meter ?? new NoopMeter();
}

export function getPromRegistry() {
  return currentObservability?.promRegistry ?? new NoopRegistry();
}

export async function getPromMetrics() {
  return getPromRegistry().metrics();
}

export function summarizeObservability(observability = currentObservability) {
  const target = observability ?? currentObservability;
  const tracer = target?.tracer ?? new NoopTracer();
  const meter = target?.meter ?? target?.metrics ?? new NoopMeter();
  const promRegistry = target?.promRegistry ?? new NoopRegistry();
  const metricSummary = meter.summary();

  return {
    tracing: {
      provider: tracer instanceof SimpleTracer ? 'simple-tracer' : 'noop',
      spanCount: tracer.getSpans().length,
      errorSpanCount: tracer.getErrorSpans().length,
      otlpEndpoint: tracer.otlpEndpoint ?? null,
    },
    metrics: {
      provider: meter instanceof SimpleMetrics ? 'simple-metrics' : 'noop',
      counters: metricSummary.counters,
      gauges: metricSummary.gauges,
      histograms: metricSummary.histograms,
      serverRunning: false,
      contentType: promRegistry.contentType,
      prefix: target?.config?.metrics?.prefix ?? '',
      defaultLabels: { ...(target?.config?.metrics?.defaultLabels ?? {}) },
    },
  };
}

export async function shutdownObservability() {
  currentObservability = null;
}

export {
  Span,
  SimpleTracer,
  NoopTracer,
  SimpleMetrics,
  SimpleRegistry,
};
