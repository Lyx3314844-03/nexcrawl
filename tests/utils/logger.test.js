import { test } from 'node:test';
import assert from 'node:assert';
import { Logger } from '../../src/utils/logger.js';

test('Logger - log levels', () => {
  const logger = new Logger({ level: 'warn', json: false, timestamp: false });
  
  // Should not log debug/info
  logger.debug('debug message');
  logger.info('info message');
  
  // Should log warn/error
  logger.warn('warn message');
  logger.error('error message');
});

test('Logger - JSON output', () => {
  const logger = new Logger({ level: 'info', json: true, timestamp: false });
  
  // Capture console output
  const originalLog = console.info;
  let output = '';
  console.info = (msg) => { output = msg; };
  
  logger.info('test message', { key: 'value' });
  
  console.info = originalLog;
  
  const parsed = JSON.parse(output);
  assert.strictEqual(parsed.level, 'info');
  assert.strictEqual(parsed.msg, 'test message');
  assert.strictEqual(parsed.key, 'value');
});

test('Logger - child logger', () => {
  const parent = new Logger({ name: 'parent', level: 'info' });
  const child = parent.child({ name: 'child' });
  
  assert.strictEqual(child.name, 'child');
  assert.strictEqual(child.level, 'info');
});
