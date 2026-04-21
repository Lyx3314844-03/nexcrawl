import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PrometheusExporter } from '../src/runtime/prometheus-exporter.js';

describe('PrometheusExporter', () => {
  it('should register and increment counter', () => {
    const exporter = new PrometheusExporter();
    exporter.counter('test_counter', 'Test counter', ['label']);
    
    exporter.inc('test_counter', { label: 'value1' }, 5);
    exporter.inc('test_counter', { label: 'value1' }, 3);
    
    const output = exporter.toPrometheus();
    assert.ok(output.includes('test_counter{label="value1"} 8'));
  });

  it('should register and set gauge', () => {
    const exporter = new PrometheusExporter();
    exporter.gauge('test_gauge', 'Test gauge', []);
    
    exporter.set('test_gauge', {}, 42);
    
    const output = exporter.toPrometheus();
    assert.ok(output.includes('test_gauge{} 42'));
  });

  it('should register and observe histogram', () => {
    const exporter = new PrometheusExporter();
    exporter.histogram('test_histogram', 'Test histogram', [], [1, 5, 10]);
    
    exporter.observe('test_histogram', {}, 0.5);
    exporter.observe('test_histogram', {}, 3);
    exporter.observe('test_histogram', {}, 7);
    
    const output = exporter.toPrometheus();
    assert.ok(output.includes('test_histogram_bucket{le="1"} 1'));
    assert.ok(output.includes('test_histogram_bucket{le="5"} 2'));
    assert.ok(output.includes('test_histogram_bucket{le="10"} 3'));
    assert.ok(output.includes('test_histogram_sum{} 10.5'));
    assert.ok(output.includes('test_histogram_count{} 3'));
  });

  it('should handle multiple labels', () => {
    const exporter = new PrometheusExporter();
    exporter.counter('test_multi', 'Test multi-label', ['method', 'status']);
    
    exporter.inc('test_multi', { method: 'GET', status: '200' }, 1);
    exporter.inc('test_multi', { method: 'POST', status: '201' }, 2);
    
    const output = exporter.toPrometheus();
    assert.ok(output.includes('method="GET",status="200"'));
    assert.ok(output.includes('method="POST",status="201"'));
  });

  it('should include process uptime', () => {
    const exporter = new PrometheusExporter();
    const output = exporter.toPrometheus();
    
    assert.ok(output.includes('process_uptime_seconds'));
    assert.ok(output.includes('# TYPE process_uptime_seconds gauge'));
  });
});
