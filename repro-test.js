
import { test } from 'node:test';
import assert from 'node:assert';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWorkflow } from './src/index.js';

test('reproduce: job runner discovery rules', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);

    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`
        <html>
          <head><title>Discovery Home</title></head>
          <body>
            <a href="/list?page=1">Category listing</a>
            <a href="/detail/42">Product detail</a>
            <a href="/private" rel="nofollow">Private area</a>
            <a href="/logout">Logout</a>
            <a href="/brochure.pdf">Brochure</a>
          </body>
        </html>
      `);
      return;
    }

    if (req.url === '/detail/42') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Detail 42</title></head><body>detail</body></html>');
      return;
    }

    if (req.url === '/list?page=1') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html><head><title>Listing</title></head><body>list</body></html>');
      return;
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('should not be fetched');
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-repro-'));

  try {
    const summary = await runWorkflow(
      {
        name: 'discovery-rules',
        seedUrls: [`${baseUrl}/`],
        mode: 'http',
        concurrency: 1,
        maxDepth: 1,
        discovery: {
          enabled: true,
          maxPages: 10,
          maxLinksPerPage: 10,
          sameOriginOnly: true,
          respectNoFollow: true,
          skipFileExtensions: ['pdf'],
          rules: [
            { pattern: '/logout$', action: 'skip' },
            { pattern: '/detail/', priority: 90, label: 'detail', userData: { lane: 'detail' }, metadata: { bucket: 'detail' } },
            { pattern: '/list', priority: 10, label: 'listing', userData: { lane: 'listing' }, metadata: { bucket: 'listing' } },
          ],
          extractor: { name: 'links', type: 'links', all: true, format: 'object' },
        },
        extract: [
          { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
        ],
        output: {
          dir: 'runs',
          persistBodies: false,
          console: true,
        },
      },
      { projectRoot: root },
    );

    console.log('Summary pagesFetched:', summary.pagesFetched);
    console.log('Requests:', requests);

    const resultsRaw = await readFile(join(summary.runDir, 'results.ndjson'), 'utf8');
    const records = resultsRaw.trim().split('\n').map(l => JSON.parse(l));
    console.log('Results URLs:', records.map(r => r.url));

  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
