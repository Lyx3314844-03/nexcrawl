import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('cli media command extracts media and optionally downloads files', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/cover.jpg') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('cover'));
      return;
    }

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`
      <html>
        <head>
          <meta property="og:image" content="/cover.jpg" />
        </head>
        <body>
          <img src="/cover.jpg" alt="cover" />
        </body>
      </html>
    `);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-media-'));
  const cliPath = resolve('src/cli.js');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'media',
      `${baseUrl}/`,
      '--mode',
      'http',
      '--download',
      'true',
      '--network',
      'false',
      '--output-dir',
      'downloads/media',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.summary.status, 'completed');
    assert.equal(payload.items.total, 1);
    assert.match(JSON.stringify(payload.items.items[0]), new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cover\\.jpg`));
    assert.equal(payload.downloads.length, 1);
    assert.equal(payload.downloads[0].downloaded, 1);

    const files = await readdir(join(root, 'downloads', 'media', 'image'));
    assert.ok(files.includes('cover.jpg'));
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('cli media command supports recursive discovery across linked pages', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/poster.jpg') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('poster'));
      return;
    }

    if (req.url === '/detail') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body><img src="/poster.jpg" alt="poster" /></body></html>');
      return;
    }

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body><a href="/detail">detail</a></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-media-recursive-'));
  const cliPath = resolve('src/cli.js');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'media',
      `${baseUrl}/`,
      '--mode',
      'http',
      '--max-depth',
      '1',
      '--max-pages',
      '5',
      '--network',
      'false',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.summary.status, 'completed');
    assert.ok(payload.items.total >= 2);
    assert.match(JSON.stringify(payload.items.items), new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/poster\\.jpg`));
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('cli media command supports kind filtering and recursive include/exclude rules', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/video.mp4') {
      res.setHeader('content-type', 'video/mp4');
      res.end(Buffer.from('video'));
      return;
    }

    if (req.url === '/image.jpg') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('image'));
      return;
    }

    if (req.url === '/allowed') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body><video src="/video.mp4"></video><img src="/image.jpg" /></body></html>');
      return;
    }

    if (req.url === '/blocked') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<html><body><video src="/blocked.mp4"></video></body></html>');
      return;
    }

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body><a href="/allowed">allowed</a><a href="/blocked">blocked</a></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-media-filtered-'));
  const cliPath = resolve('src/cli.js');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'media',
      `${baseUrl}/`,
      '--mode',
      'http',
      '--kind',
      'video',
      '--max-depth',
      '1',
      '--include',
      '/allowed',
      '--exclude',
      '/blocked',
      '--network',
      'false',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.summary.status, 'completed');
    const serialized = JSON.stringify(payload.items.items);
    assert.match(serialized, /video\.mp4/);
    assert.doesNotMatch(serialized, /image\.jpg/);
    assert.doesNotMatch(serialized, /blocked/);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('cli media command supports media url include/exclude filters', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/video.mp4') {
      res.setHeader('content-type', 'video/mp4');
      res.end(Buffer.from('video'));
      return;
    }

    if (req.url === '/image.jpg') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('image'));
      return;
    }

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body><video src="/video.mp4"></video><img src="/image.jpg" /></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-media-url-filter-'));
  const cliPath = resolve('src/cli.js');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'media',
      `${baseUrl}/`,
      '--mode',
      'http',
      '--kind',
      'image,video',
      '--media-exclude',
      'image\\.jpg',
      '--network',
      'false',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const payload = JSON.parse(stdout);
    const serialized = JSON.stringify(payload.items.items);
    assert.match(serialized, /video\.mp4/);
    assert.doesNotMatch(serialized, /image\.jpg/);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('cli media command retries directly from a failures manifest without seed urls', async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts += 1;
    res.setHeader('content-type', 'image/jpeg');
    res.end(Buffer.from('cover'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-cli-media-retry-'));
  const cliPath = resolve('src/cli.js');
  const failuresPath = join(root, 'failed.ndjson');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    await appendFile(failuresPath, `${JSON.stringify({
      ok: false,
      url: `${baseUrl}/retry.jpg`,
      kind: 'image',
      title: 'retry-cover',
      pageUrl: 'https://site.example.com/gallery',
    })}\n`);

    const { stdout } = await execFileAsync(process.execPath, [
      cliPath,
      'media',
      '--retry-failed-from',
      failuresPath,
      '--output-dir',
      'downloads/media',
      '--cwd',
      root,
    ], {
      cwd: resolve('.'),
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.summary.status, 'completed');
    assert.equal(payload.summary.mode, 'retry-failed');
    assert.equal(payload.summary.source, failuresPath);
    assert.equal(payload.downloads.length, 1);
    assert.equal(payload.downloads[0].downloaded, 1);
    assert.equal(attempts, 1);

    const files = await readdir(join(root, 'downloads', 'media', 'image'));
    assert.ok(files.includes('retry.jpg'));
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
