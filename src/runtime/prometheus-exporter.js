/**
 * PrometheusExporter - Export metrics in Prometheus format
 * 
 * Provides counters, gauges, and histograms for monitoring crawler performance.
 */

export class PrometheusExporter {
  constructor() {
    this.metrics = new Map();
    this.startTime = Date.now();
  }

  /**
   * Register a counter metric
   * @param {string} name - Metric name
   * @param {string} help - Help text
   * @param {string[]} labels - Label names
   */
  counter(name, help, labels = []) {
    this.metrics.set(name, {
      type: 'counter',
      help,
      labels,
      values: new Map(),
    });
  }

  /**
   * Register a gauge metric
   * @param {string} name - Metric name
   * @param {string} help - Help text
   * @param {string[]} labels - Label names
   */
  gauge(name, help, labels = []) {
    this.metrics.set(name, {
      type: 'gauge',
      help,
      labels,
      values: new Map(),
    });
  }

  /**
   * Register a histogram metric
   * @param {string} name - Metric name
   * @param {string} help - Help text
   * @param {string[]} labels - Label names
   * @param {number[]} buckets - Histogram buckets
   */
  histogram(name, help, labels = [], buckets = [0.1, 0.5, 1, 2, 5, 10]) {
    this.metrics.set(name, {
      type: 'histogram',
      help,
      labels,
      buckets,
      values: new Map(),
    });
  }

  /**
   * Increment a counter
   * @param {string} name - Metric name
   * @param {Object} labels - Label values
   * @param {number} value - Increment value
   */
  inc(name, labels = {}, value = 1) {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'counter') return;

    const key = this._labelKey(labels);
    const current = metric.values.get(key) || 0;
    metric.values.set(key, current + value);
  }

  /**
   * Set a gauge value
   * @param {string} name - Metric name
   * @param {Object} labels - Label values
   * @param {number} value - Gauge value
   */
  set(name, labels = {}, value) {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'gauge') return;

    const key = this._labelKey(labels);
    metric.values.set(key, value);
  }

  /**
   * Observe a histogram value
   * @param {string} name - Metric name
   * @param {Object} labels - Label values
   * @param {number} value - Observed value
   */
  observe(name, labels = {}, value) {
    const metric = this.metrics.get(name);
    if (!metric || metric.type !== 'histogram') return;

    const key = this._labelKey(labels);
    let hist = metric.values.get(key);
    if (!hist) {
      hist = {
        sum: 0,
        count: 0,
        buckets: new Map(metric.buckets.map(b => [b, 0])),
      };
      metric.values.set(key, hist);
    }

    hist.sum += value;
    hist.count++;
    for (const bucket of metric.buckets) {
      if (value <= bucket) {
        hist.buckets.set(bucket, hist.buckets.get(bucket) + 1);
      }
    }
  }

  /**
   * Generate Prometheus text format
   * @returns {string} Metrics in Prometheus format
   */
  toPrometheus() {
    const lines = [];

    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} ${metric.type}`);

      if (metric.type === 'histogram') {
        for (const [labelKey, hist] of metric.values) {
          const labels = this._parseLabels(labelKey);
          const labelSep = labels ? `${labels},` : '';
          for (const [bucket, count] of hist.buckets) {
            lines.push(`${name}_bucket{${labelSep}le="${bucket}"} ${count}`);
          }
          lines.push(`${name}_bucket{${labelSep}le="+Inf"} ${hist.count}`);
          lines.push(`${name}_sum{${labels}} ${hist.sum}`);
          lines.push(`${name}_count{${labels}} ${hist.count}`);
        }
      } else {
        for (const [labelKey, value] of metric.values) {
          const labels = this._parseLabels(labelKey);
          lines.push(`${name}{${labels}} ${value}`);
        }
      }
    }

    // Add process metrics
    const uptime = (Date.now() - this.startTime) / 1000;
    lines.push('# HELP process_uptime_seconds Process uptime in seconds');
    lines.push('# TYPE process_uptime_seconds gauge');
    lines.push(`process_uptime_seconds ${uptime}`);

    return lines.join('\n') + '\n';
  }

  _labelKey(labels) {
    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v}"`)
      .join(',');
  }

  _parseLabels(key) {
    return key || '';
  }
}

// Global instance
export const metrics = new PrometheusExporter();

// Register default metrics
metrics.counter('omnicrawl_requests_total', 'Total number of requests', ['status', 'domain']);
metrics.histogram('omnicrawl_request_duration_seconds', 'Request duration in seconds', ['domain'], [0.1, 0.5, 1, 2, 5, 10]);
metrics.gauge('omnicrawl_active_requests', 'Number of active requests', []);
metrics.gauge('omnicrawl_queue_depth', 'Number of requests in queue', []);
metrics.counter('omnicrawl_errors_total', 'Total number of errors', ['type']);
