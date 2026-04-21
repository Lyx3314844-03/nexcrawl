import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  downloadMediaAsset,
  downloadMediaAssets,
  collectMediaAssetsFromResult,
  filterMediaAssets,
  readMediaDownloadManifest,
  collectFailedMediaDownloads,
  retryFailedMediaDownloads,
} from '../src/runtime/media-downloader.js';

test('downloadMediaAsset writes a fetched media file to disk', async () => {
  const binary = Buffer.from('fake-audio');
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'audio/mpeg');
    res.setHeader('content-disposition', 'attachment; filename="track.mp3"');
    res.end(binary);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-single-'));
  const url = `http://127.0.0.1:${server.address().port}/audio`;

  try {
    const result = await downloadMediaAsset({ url, kind: 'audio' }, {
      outputDir: root,
    });

    assert.equal(result.ok, true);
    assert.equal(result.fileName, 'track.mp3');
    const files = await readdir(join(root, 'audio'));
    assert.ok(files.includes('track.mp3'));
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('downloadMediaAssets downloads unique assets and collects summary', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/cover.jpg') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('cover'));
      return;
    }

    res.setHeader('content-type', 'video/mp4');
    res.end(Buffer.from('video'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-batch-'));
  const port = server.address().port;

  try {
    const summary = await downloadMediaAssets([
      { url: `http://127.0.0.1:${port}/cover.jpg`, kind: 'image' },
      { url: `http://127.0.0.1:${port}/clip.mp4`, kind: 'video' },
      { url: `http://127.0.0.1:${port}/cover.jpg`, kind: 'image' },
    ], {
      outputDir: root,
      manifestPath: join(root, 'downloads.ndjson'),
    });

    assert.equal(summary.total, 2);
    assert.equal(summary.downloaded, 2);
    const manifest = await readFile(join(root, 'downloads.ndjson'), 'utf8');
    assert.match(manifest, /cover\.jpg/);
    assert.match(manifest, /clip\.mp4/);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('collectMediaAssetsFromResult deduplicates across extracted fields', () => {
  const assets = collectMediaAssetsFromResult({
    extracted: {
      media: [{ url: 'https://cdn.example.com/a.jpg', kind: 'image' }],
      images: [{ url: 'https://cdn.example.com/a.jpg', kind: 'image' }],
      videos: [{ url: 'https://cdn.example.com/b.mp4', kind: 'video' }],
    },
  });

  assert.equal(assets.length, 2);
  assert.equal(assets[0].url, 'https://cdn.example.com/a.jpg');
  assert.equal(assets[1].url, 'https://cdn.example.com/b.mp4');
});

test('filterMediaAssets filters by media url include/exclude patterns', () => {
  const assets = filterMediaAssets([
    { url: 'https://cdn.example.com/a.jpg', kind: 'image' },
    { url: 'https://cdn.example.com/b.mp4', kind: 'video' },
    { url: 'https://cdn.example.com/c.mp3', kind: 'audio' },
  ], {
    mediaInclude: ['cdn\\.example\\.com'],
    mediaExclude: ['\\.jpg$', '\\.mp3$'],
  });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].url, 'https://cdn.example.com/b.mp4');
});

test('downloadMediaAsset resolves hls playlists and merges segment files', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/master.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=320000\n/variant.m3u8\n');
      return;
    }

    if (req.url === '/variant.m3u8') {
      res.setHeader('content-type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXTINF:4,\n/seg-1.ts\n#EXTINF:4,\n/seg-2.ts\n');
      return;
    }

    if (req.url === '/seg-1.ts') {
      res.setHeader('content-type', 'video/mp2t');
      res.end(Buffer.from('segment-one'));
      return;
    }

    if (req.url === '/seg-2.ts') {
      res.setHeader('content-type', 'video/mp2t');
      res.end(Buffer.from('segment-two'));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-hls-'));
  const url = `http://127.0.0.1:${server.address().port}/master.m3u8`;

  try {
    const result = await downloadMediaAsset({ url, kind: 'video', title: 'playlist-demo' }, {
      outputDir: root,
    });

    assert.equal(result.ok, true);
    assert.equal(result.streaming?.type, 'hls');
    assert.equal(result.streaming?.segmentCount, 2);
    assert.equal(result.fileName, 'playlist-demo.ts');
    const data = await readFile(join(root, 'video', 'playlist-demo.ts'));
    assert.equal(data.toString('utf8'), 'segment-onesegment-two');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('downloadMediaAsset resolves basic dash manifests and merges segment files', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/stream.mpd') {
      res.setHeader('content-type', 'application/dash+xml');
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<MPD mediaPresentationDuration="PT4S">
  <Period>
    <AdaptationSet>
      <Representation id="video-1" bandwidth="1000">
        <BaseURL>/dash/</BaseURL>
        <SegmentList>
          <Initialization sourceURL="init.mp4" />
          <SegmentURL media="chunk-1.m4s" />
          <SegmentURL media="chunk-2.m4s" />
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`);
      return;
    }

    if (req.url === '/dash/init.mp4') {
      res.setHeader('content-type', 'video/mp4');
      res.end(Buffer.from('init'));
      return;
    }

    if (req.url === '/dash/chunk-1.m4s') {
      res.setHeader('content-type', 'video/iso.segment');
      res.end(Buffer.from('chunk1'));
      return;
    }

    if (req.url === '/dash/chunk-2.m4s') {
      res.setHeader('content-type', 'video/iso.segment');
      res.end(Buffer.from('chunk2'));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-dash-'));
  const url = `http://127.0.0.1:${server.address().port}/stream.mpd`;

  try {
    const result = await downloadMediaAsset({ url, kind: 'video', title: 'dash-demo' }, {
      outputDir: root,
    });

    assert.equal(result.ok, true);
    assert.equal(result.streaming?.type, 'dash');
    assert.equal(result.streaming?.segmentCount, 3);
    assert.equal(result.fileName, 'dash-demo.mp4');
    const data = await readFile(join(root, 'video', 'dash-demo.mp4'));
    assert.equal(data.toString('utf8'), 'initchunk1chunk2');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('downloadMediaAssets supports subdir and filename templates', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'image/jpeg');
    res.end(Buffer.from('templated'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-template-'));
  const port = server.address().port;

  try {
    const summary = await downloadMediaAssets([
      {
        url: `http://127.0.0.1:${port}/cover.jpg`,
        kind: 'image',
        title: 'cover-art',
        pageUrl: 'https://site.example.com/albums/1',
      },
    ], {
      outputDir: root,
      subdirTemplate: '{pageHost}/{kind}',
      fileNameTemplate: '{host}-{title}-{index}',
    });

    assert.equal(summary.downloaded, 1);
    const files = await readdir(join(root, 'site.example.com', 'image'));
    assert.equal(files.length, 1);
    assert.match(files[0], /^127\.0\.0\.1_\d+-cover-art-0001\.jpg$/);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('downloadMediaAsset retries transient failures before succeeding', async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts += 1;
    if (attempts < 2) {
      res.statusCode = 503;
      res.end('retry');
      return;
    }

    res.setHeader('content-type', 'image/jpeg');
    res.end(Buffer.from('ok'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-retry-'));
  const url = `http://127.0.0.1:${server.address().port}/retry.jpg`;

  try {
    const result = await downloadMediaAsset({ url, kind: 'image' }, {
      outputDir: root,
      retryAttempts: 3,
      retryBackoffMs: 1,
    });

    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.equal(attempts, 2);
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('retryFailedMediaDownloads replays only failed assets from a manifest', async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts += 1;
    res.setHeader('content-type', 'image/jpeg');
    res.end(Buffer.from('ok'));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-retry-manifest-'));
  const failuresPath = join(root, 'failed.ndjson');
  const successPath = join(root, 'downloads.ndjson');
  const url = `http://127.0.0.1:${server.address().port}/retry.jpg`;

  try {
    await appendFile(failuresPath, `${JSON.stringify({
      ok: false,
      url,
      kind: 'image',
      title: 'retry-cover',
      pageUrl: 'https://site.example.com/albums/1',
    })}\n`);
    await appendFile(failuresPath, `${JSON.stringify({
      ok: false,
      url,
      kind: 'image',
      title: 'retry-cover',
      pageUrl: 'https://site.example.com/albums/1',
    })}\n`);

    const summary = await retryFailedMediaDownloads(failuresPath, {
      outputDir: root,
      manifestPath: successPath,
      subdirTemplate: '{pageHost}/{kind}',
      fileNameTemplate: '{title}-{index}',
    });

    assert.equal(summary.downloaded, 1);
    assert.equal(attempts, 1);
    const files = await readdir(join(root, 'site.example.com', 'image'));
    assert.ok(files.includes('retry-cover-0001.jpg'));
    const records = await readMediaDownloadManifest(successPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].ok, true);
    assert.equal(records[0].title, 'retry-cover');
    assert.equal(records[0].pageUrl, 'https://site.example.com/albums/1');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('downloadMediaAssets writes only failed records to failures manifest', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/ok.jpg') {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from('ok'));
      return;
    }

    res.statusCode = 503;
    res.end('retry');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(join(tmpdir(), 'omnicrawl-media-failures-'));
  const failuresPath = join(root, 'failed.ndjson');
  const port = server.address().port;

  try {
    const summary = await downloadMediaAssets([
      { url: `http://127.0.0.1:${port}/ok.jpg`, kind: 'image', title: 'ok' },
      { url: `http://127.0.0.1:${port}/fail.jpg`, kind: 'image', title: 'broken', pageUrl: 'https://site.example.com/fail' },
    ], {
      outputDir: root,
      failuresPath,
      retryAttempts: 1,
    });

    assert.equal(summary.downloaded, 1);
    assert.equal(summary.failed, 1);
    const failures = await readMediaDownloadManifest(failuresPath);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].ok, false);
    assert.equal(failures[0].title, 'broken');
    assert.equal(failures[0].pageUrl, 'https://site.example.com/fail');
  } finally {
    server.close();
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});

test('collectFailedMediaDownloads returns failed records only once per url', () => {
  const failures = collectFailedMediaDownloads([
    { ok: true, url: 'https://cdn.example.com/a.jpg', kind: 'image' },
    { ok: false, url: 'https://cdn.example.com/b.mp4', kind: 'video' },
    { skipped: true, url: 'https://cdn.example.com/c.mp3', kind: 'audio' },
    { ok: false, url: 'https://cdn.example.com/b.mp4', kind: 'video' },
  ]);

  assert.equal(failures.length, 1);
  assert.equal(failures[0].url, 'https://cdn.example.com/b.mp4');
});
