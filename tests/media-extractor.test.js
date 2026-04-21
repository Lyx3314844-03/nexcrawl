import test from 'node:test';
import assert from 'node:assert/strict';
import { extractMediaAssets, buildMediaExtractRules } from '../src/extractors/media-extractor.js';
import { runExtractors } from '../src/extractors/extractor-engine.js';

function createHtmlResponse(body, overrides = {}) {
  return {
    body,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...(overrides.headers ?? {}),
    },
    finalUrl: overrides.finalUrl ?? 'https://example.com/gallery',
    debug: overrides.debug ?? null,
    domMeta: overrides.domMeta ?? { title: 'gallery' },
  };
}

test('extractMediaAssets discovers image, video, and audio assets from DOM, meta, and JSON-LD', () => {
  const response = createHtmlResponse(`
    <html>
      <head>
        <meta property="og:image" content="/meta/cover.jpg" />
        <meta property="og:video" content="https://cdn.example.com/trailer.mp4" />
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "MusicRecording",
            "name": "Demo Song",
            "audio": {
              "@type": "AudioObject",
              "contentUrl": "https://cdn.example.com/audio/demo.mp3",
              "encodingFormat": "audio/mpeg"
            }
          }
        </script>
      </head>
      <body>
        <img src="/img/photo.jpg" srcset="/img/photo@2x.jpg 2x" alt="photo" />
        <video src="/video/movie.mp4" poster="/img/poster.jpg"></video>
        <audio src="/audio/track.ogg"></audio>
        <a href="/downloads/bonus.flac">download</a>
      </body>
    </html>
  `);

  const assets = extractMediaAssets(response, {
    format: 'object',
    all: true,
    maxItems: 20,
  });

  assert.ok(assets.some((item) => item.kind === 'image' && item.url === 'https://example.com/img/photo.jpg'));
  assert.ok(assets.some((item) => item.kind === 'image' && item.url === 'https://example.com/meta/cover.jpg'));
  assert.ok(assets.some((item) => item.kind === 'video' && item.url === 'https://example.com/video/movie.mp4'));
  assert.ok(assets.some((item) => item.kind === 'video' && item.url === 'https://cdn.example.com/trailer.mp4'));
  assert.ok(assets.some((item) => item.kind === 'audio' && item.url === 'https://example.com/audio/track.ogg'));
  assert.ok(assets.some((item) => item.kind === 'audio' && item.url === 'https://cdn.example.com/audio/demo.mp3'));
  assert.ok(assets.some((item) => item.kind === 'audio' && item.url === 'https://example.com/downloads/bonus.flac'));
});

test('extractMediaAssets includes browser network-discovered media requests', () => {
  const response = createHtmlResponse('<html><body>networked page</body></html>', {
    debug: {
      requests: [
        {
          url: 'https://stream.example.com/live/master.m3u8',
          mimeType: 'application/vnd.apple.mpegurl',
          responseHeaders: {
            'content-type': 'application/vnd.apple.mpegurl',
          },
        },
        {
          url: 'https://cdn.example.com/audio/live.aac',
          mimeType: 'audio/aac',
          responseHeaders: {
            'content-type': 'audio/aac',
          },
        },
      ],
    },
  });

  const assets = extractMediaAssets(response, {
    format: 'object',
    all: true,
    maxItems: 20,
  });

  assert.ok(assets.some((item) => item.kind === 'video' && item.source === 'network' && item.url === 'https://stream.example.com/live/master.m3u8'));
  assert.ok(assets.some((item) => item.kind === 'audio' && item.source === 'network' && item.url === 'https://cdn.example.com/audio/live.aac'));
});

test('media extractor rule integrates with runExtractors', async () => {
  const workflow = {
    browser: {},
    extract: [
      {
        name: 'media',
        type: 'media',
        all: true,
        format: 'object',
      },
      {
        name: 'videos',
        type: 'media',
        all: true,
        format: 'url',
        kinds: ['video'],
      },
    ],
  };

  const response = createHtmlResponse(`
    <html>
      <body>
        <img src="/img/a.jpg" />
        <video src="/video/a.mp4"></video>
      </body>
    </html>
  `);

  const extracted = await runExtractors({
    workflow,
    response,
  });

  assert.ok(Array.isArray(extracted.media));
  assert.ok(extracted.media.some((item) => item.kind === 'image' && item.url === 'https://example.com/img/a.jpg'));
  assert.deepEqual(extracted.videos, ['https://example.com/video/a.mp4']);
});

test('buildMediaExtractRules generates combined and per-kind rules', () => {
  const rules = buildMediaExtractRules({
    format: 'object',
    maxItems: 120,
  });

  assert.equal(rules.length, 4);
  assert.equal(rules[0].name, 'media');
  assert.equal(rules[1].name, 'images');
  assert.deepEqual(rules[1].kinds, ['image']);
  assert.equal(rules[2].name, 'videos');
  assert.deepEqual(rules[2].kinds, ['video']);
  assert.equal(rules[3].name, 'audio');
  assert.deepEqual(rules[3].kinds, ['audio']);
});
