// Debug: check what request.identity looks like when enforceIdentityConsistency is called
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Monkey-patch job-runner to log
const jobRunnerModule = await import('./src/runtime/job-runner.js');
const JobRunner = jobRunnerModule.JobRunner;

// Patch the processItem method to log request.identity
const origProcessItem = JobRunner.prototype.processItem;
JobRunner.prototype.processItem = async function(item) {
  const origEnforce = this.workflow;
  // We'll intercept by patching the module-level function via a wrapper
  return origProcessItem.call(this, item);
};

import { OmniCrawler } from './src/api/omnicrawler.js';

const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = `http://127.0.0.1:${server.address().port}/test`;
const root = await mkdtemp(join(tmpdir(), 'omnicrawl-debug-'));

const crawler = new OmniCrawler({ name: 'debug', projectRoot: root })
  .addRequests([{ url, headers: { 'user-agent': 'BadUA/0.1', 'accept-language': 'en-US' } }])
  .setMode('http')
  .setIdentity({ enabled: true, userAgent: 'ExpectedUA/1.0', acceptLanguage: 'zh-CN,zh' });

await crawler.run();
const runner = crawler._runner;
console.log('workflow.identity:', JSON.stringify(runner.workflow?.identity, null, 2));
const result = runner.completed[0];
if (result) {
  console.log('result.identity.consistency:', JSON.stringify(result.identity?.consistency, null, 2));
}
server.close();
await rm(root, { recursive: true, force: true });
