#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createLogger } from './core/logger.js';
import { writeJson, ensureDir } from './utils/fs.js';
import { loadWorkflow } from './runtime/workflow-loader.js';
import { runWorkflow } from './runtime/job-runner.js';
import { HistoryStore } from './runtime/history-store.js';
import { WorkflowRegistry } from './runtime/workflow-registry.js';
import { ScheduleManager } from './runtime/scheduler.js';
import { SessionStore } from './runtime/session-store.js';
import { ProxyPool } from './runtime/proxy-pool.js';
import { getBrowserPoolSnapshot } from './runtime/browser-pool.js';
import { JobStore } from './runtime/job-store.js';
import { SqliteJobStore } from './runtime/sqlite-job-store.js';
import { SqliteScheduleManager } from './runtime/sqlite-scheduler.js';
import { resolveDistributedConfig } from './runtime/distributed-config.js';
import { inspectOptionalIntegrations, probeIntegration, probeIntegrations } from './runtime/integration-registry.js';
import { MediaCrawler, Router, buildMediaExtractRules, filterMediaAssets, retryFailedMediaDownloads } from './index.js';
import { getCapabilities, startServer } from './server.js';

const logger = createLogger({ component: 'cli' });

function parseOptions(argv) {
  const positional = [];
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const [rawKey, rawValue] = token.slice(2).split('=');
    const key = rawKey.trim();

    if (rawValue !== undefined) {
      options[key] = rawValue;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue && !nextValue.startsWith('--')) {
      options[key] = nextValue;
      index += 1;
      continue;
    }

    options[key] = true;
  }

  return { positional, options };
}

function printHelp() {
  process.stdout.write(
    [
      'OmniCrawl CLI',
      '',
      'Commands:',
      '  omnicrawl run <workflow.json> [--cwd <dir>]',
      '  omnicrawl media [<url...>] [--input-file <file>] [--retry-failed-from <failed.ndjson>] [--mode browser|http] [--kind image|video|audio[,..]] [--download true|false] [--retry-attempts <n>] [--retry-backoff-ms <ms>] [--max-depth <n>] [--max-pages <n>] [--include <regex[,..]>] [--exclude <regex[,..]>] [--media-include <regex[,..]>] [--media-exclude <regex[,..]>] [--output-dir <dir>] [--cwd <dir>]',
      '  omnicrawl serve [--port 3100] [--host 127.0.0.1] [--api-key <key>] [--cwd <dir>]',
      '  omnicrawl scaffold [target.json]',
      '  omnicrawl init [dir]                 Generate a starter crawler script with programmatic API',
      '  omnicrawl register <workflow.json> [--id <workflowId>] [--cwd <dir>]',
      '  omnicrawl workflows [--cwd <dir>]',
      '  omnicrawl history [--cwd <dir>]',
      '  omnicrawl schedules [--cwd <dir>]',
      '  omnicrawl sessions [--cwd <dir>]',
      '  omnicrawl browser-pool',
      '  omnicrawl proxies [--cwd <dir>]',
      '  omnicrawl proxy-enable <key> [--cwd <dir>]',
      '  omnicrawl proxy-disable <key> [--cwd <dir>]',
      '  omnicrawl proxy-reset <key> [--cwd <dir>]',
      '  omnicrawl proxy-note <key> --text <note> [--cwd <dir>]',
      '  omnicrawl proxy-probe <key> [--url <target>] [--cwd <dir>]',
      '  omnicrawl integrations',
      '  omnicrawl integration-probe <id> [--config-json <json>] [--dry-run true|false]',
      '  omnicrawl integration-probe --all [--dry-run true|false]',
      '  omnicrawl capabilities',
      '',
    ].join('\n'),
  );
}

function parseBooleanOption(value, defaultValue = false) {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseIntegerOption(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseListOption(value) {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => parseListOption(item));
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function starterWorkflow() {
  return {
    name: 'starter-workflow',
    seedUrls: ['https://example.com'],
    mode: 'hybrid',
    concurrency: 2,
    maxDepth: 1,
    extract: [
      { name: 'title', type: 'regex', pattern: '<title>([^<]+)</title>' },
      { name: 'surface', type: 'surface' },
    ],
    discovery: {
      enabled: true,
      maxPages: 5,
      sameOriginOnly: true,
      extractor: { name: 'links', type: 'links', all: true },
    },
    plugins: [{ name: 'dedupe' }, { name: 'audit' }],
    output: {
      dir: 'runs',
      persistBodies: false,
      console: true,
    },
  };
}

async function runMediaCommand(targetUrl, options = {}) {
  const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
  const download = parseBooleanOption(options.download, false);
  const retryFailedFrom = options['retry-failed-from'] ? resolve(cwd, String(options['retry-failed-from'])) : null;
  const includeNetwork = parseBooleanOption(options.network, true);
  const mode = ['http', 'browser', 'hybrid', 'cheerio'].includes(String(options.mode ?? '').toLowerCase())
    ? String(options.mode).toLowerCase()
    : 'browser';
  const outputDir = options['output-dir'] ? String(options['output-dir']) : 'artifacts/media';
  const manifestPath = options['manifest-file'] ? resolve(cwd, String(options['manifest-file'])) : resolve(cwd, outputDir, 'downloads.ndjson');
  const failuresPath = options['failures-file'] ? resolve(cwd, String(options['failures-file'])) : resolve(cwd, outputDir, 'failed-downloads.ndjson');
  const timeoutMs = parseIntegerOption(options.timeoutMs, 45000);
  const maxItems = parseIntegerOption(options['max-items'], 300);
  const concurrency = parseIntegerOption(options.concurrency, 4);
  const retryAttempts = Math.max(1, parseIntegerOption(options['retry-attempts'], 2));
  const retryBackoffMs = Math.max(0, parseIntegerOption(options['retry-backoff-ms'], 750));
  const maxDepth = Math.max(0, parseIntegerOption(options['max-depth'], 0));
  const maxPages = Math.max(1, parseIntegerOption(options['max-pages'], Math.max(20, maxDepth > 0 ? 50 : 20)));
  const sameOriginOnly = parseBooleanOption(options['same-origin'], true);
  const selectedKinds = parseListOption(options.kind)
    .map((item) => item.toLowerCase())
    .filter((item) => ['image', 'video', 'audio'].includes(item));
  const uniqueKinds = [...new Set(selectedKinds)];
  const includePatterns = parseListOption(options.include);
  const excludePatterns = parseListOption(options.exclude);
  const mediaIncludePatterns = parseListOption(options['media-include']);
  const mediaExcludePatterns = parseListOption(options['media-exclude']);
  const effectiveKinds = uniqueKinds.length > 0 ? uniqueKinds : ['image', 'video', 'audio'];
  const selectedFields = effectiveKinds.flatMap((kind) => {
    if (kind === 'image') return ['images'];
    if (kind === 'video') return ['videos'];
    if (kind === 'audio') return ['audio'];
    return [];
  });
  const previousLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'silent';

  try {
    if (retryFailedFrom) {
      const downloadSummary = await retryFailedMediaDownloads(retryFailedFrom, {
        outputDir: resolve(cwd, outputDir),
        concurrency,
        retryAttempts,
        retryBackoffMs,
        timeoutMs,
        maxItems,
        mediaInclude: mediaIncludePatterns,
        mediaExclude: mediaExcludePatterns,
        manifestPath,
        failuresPath,
      });

      return {
        summary: {
          status: 'completed',
          mode: 'retry-failed',
          source: retryFailedFrom,
          retriedCount: downloadSummary.total,
        },
        items: {
          total: 0,
          items: [],
        },
        downloads: [downloadSummary],
      };
    }

    const router = new Router().addDefaultHandler(async (ctx) => {
      const mediaFields = {
        media: filterMediaAssets(ctx.extracted.media ?? [], {
          mediaInclude: mediaIncludePatterns,
          mediaExclude: mediaExcludePatterns,
        }),
        images: filterMediaAssets(ctx.extracted.images ?? [], {
          mediaInclude: mediaIncludePatterns,
          mediaExclude: mediaExcludePatterns,
        }),
        videos: filterMediaAssets(ctx.extracted.videos ?? [], {
          mediaInclude: mediaIncludePatterns,
          mediaExclude: mediaExcludePatterns,
        }),
        audio: filterMediaAssets(ctx.extracted.audio ?? [], {
          mediaInclude: mediaIncludePatterns,
          mediaExclude: mediaExcludePatterns,
        }),
      };
      const payload = {
        page: ctx.finalUrl,
      };

      if (effectiveKinds.length > 1) {
        payload.media = mediaFields.media;
      }
      if (effectiveKinds.includes('image')) {
        payload.images = mediaFields.images;
      }
      if (effectiveKinds.includes('video')) {
        payload.videos = mediaFields.videos;
      }
      if (effectiveKinds.includes('audio')) {
        payload.audio = mediaFields.audio;
      }

      await ctx.pushData(payload);
    });

    const crawler = new MediaCrawler({
      name: 'cli-media',
      projectRoot: cwd,
      maxMediaItems: maxItems,
      includeNetwork,
    })
      .addSeedUrls(targetUrl)
      .setMode(mode)
      .setMaxDepth(maxDepth)
      .setTimeout(timeoutMs)
      .useRouter(router);
    crawler.setExtractRules(buildMediaExtractRules({
      format: 'object',
      maxItems,
      includeNetwork,
      includeCombined: effectiveKinds.length > 1,
      includeImages: effectiveKinds.includes('image'),
      includeVideos: effectiveKinds.includes('video'),
      includeAudio: effectiveKinds.includes('audio'),
    }));
    crawler._workflowOverrides.output = {
      dir: `runs/cli-media-${Date.now()}`,
      console: false,
      persistBodies: false,
    };

    if (maxDepth > 0) {
      crawler.setDiscovery({
        enabled: true,
        maxPages,
        maxLinksPerPage: maxItems,
        sameOriginOnly,
        include: includePatterns,
        exclude: excludePatterns,
        extractor: {
          name: 'links',
          type: 'links',
          all: true,
          maxItems,
        },
      });
    }

    if (download) {
      crawler.useMediaDownload({
        outputDir,
        includeNetwork,
        concurrency,
        maxItems,
        fields: selectedFields,
        mediaInclude: mediaIncludePatterns,
        mediaExclude: mediaExcludePatterns,
        retryAttempts,
        retryBackoffMs,
        manifestPath,
        failuresPath,
      });
    }

    const summary = await crawler.run();
    const items = await crawler.listItems();
    const records = await crawler.listRecords();
    const mediaDownloadKeys = records
      .map((record) => record.key)
      .filter((key) => String(key).startsWith('MEDIA_DOWNLOADS:'))
      .sort();
    const downloads = [];

    for (const key of mediaDownloadKeys) {
      downloads.push(await crawler.getValue(key));
    }

    return {
      summary,
      items,
      downloads,
    };
  } finally {
    if (previousLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = previousLogLevel;
    }
  }
}

export async function runCommand(args) {
  const { positional, options } = parseOptions(args);
  const [command, maybeTarget, ...restTargets] = positional;

  switch (command) {
    case 'run': {
      if (!maybeTarget) {
        printHelp();
        process.exitCode = 1;
        return;
      }

      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const { workflow, source } = await loadWorkflow(maybeTarget, { cwd });
      const summary = await runWorkflow(workflow, {
        projectRoot: cwd,
        source,
      });

      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }

    case 'media': {
      const fileTargets = options['input-file']
        ? (await readFile(resolve(options.cwd ? String(options.cwd) : process.cwd(), String(options['input-file'])), 'utf8'))
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        : [];
      const targets = [maybeTarget, ...restTargets, ...fileTargets].filter(Boolean);
      const retryFailedFrom = options['retry-failed-from'];

      if (targets.length === 0 && !retryFailedFrom) {
        printHelp();
        process.exitCode = 1;
        return;
      }

      const result = await runMediaCommand(targets, options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    case 'serve': {
      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const requestedPort = Number(options.port ?? 3100);
      const requestedHost = options.host ? String(options.host) : '127.0.0.1';
      const { server } = await startServer({
        port: Number.isNaN(requestedPort) ? 3100 : requestedPort,
        host: requestedHost,
        projectRoot: cwd,
        apiKey: options['api-key'] ? String(options['api-key']) : undefined,
      });
      const address = server.address();
      logger.info('server started', {
        host: typeof address === 'object' && address ? address.address : requestedHost,
        port: address?.port ?? requestedPort,
        cwd,
        secured: Boolean(options['api-key'] || process.env.OMNICRAWL_API_KEY),
      });
      return;
    }

    case 'register': {
      if (!maybeTarget) {
        printHelp();
        process.exitCode = 1;
        return;
      }

      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const registry = new WorkflowRegistry({ projectRoot: cwd });
      const { workflow, source } = await loadWorkflow(maybeTarget, { cwd });
      const item = await registry.register({
        workflow,
        id: options.id ? String(options.id) : undefined,
        source,
      });
      process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
      return;
    }

    case 'workflows': {
      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const registry = new WorkflowRegistry({ projectRoot: cwd });
      const items = await registry.list();
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return;
    }

    case 'history': {
      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const controlPlane = resolveDistributedConfig({ projectRoot: cwd });
      const items = controlPlane.enabled
        ? (() => {
            const jobStore = new SqliteJobStore({ dbPath: controlPlane.dbPath, workerId: controlPlane.workerId });
            return jobStore.init()
              .then(() => jobStore.listHistory())
              .finally(() => jobStore.close());
          })()
        : new HistoryStore({ projectRoot: cwd }).list();
      process.stdout.write(`${JSON.stringify(await items, null, 2)}\n`);
      return;
    }

    case 'schedules': {
      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const registry = new WorkflowRegistry({ projectRoot: cwd });
      const controlPlane = resolveDistributedConfig({ projectRoot: cwd });
      const jobStore = controlPlane.enabled
        ? new SqliteJobStore({ dbPath: controlPlane.dbPath, workerId: controlPlane.workerId })
        : new JobStore({ projectRoot: cwd });
      const scheduler = controlPlane.enabled
        ? new SqliteScheduleManager({
            workflowRegistry: registry,
            jobStore,
            controlPlane,
          })
        : new ScheduleManager({
            projectRoot: cwd,
            workflowRegistry: registry,
            jobStore,
            historyStore: new HistoryStore({ projectRoot: cwd }),
            restoreTimers: false,
            launchWorkflow: async () => {
              throw new Error('launchWorkflow is not available in schedules listing mode');
            },
          });
      if (controlPlane.enabled) {
        await jobStore.init();
      }
      const items = await scheduler.list();
      await scheduler.close();
      jobStore.close?.();
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return;
    }

    case 'sessions': {
      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const sessions = new SessionStore({ projectRoot: cwd });
      const items = await sessions.list();
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return;
    }

    case 'browser-pool': {
      process.stdout.write(`${JSON.stringify(getBrowserPoolSnapshot(), null, 2)}\n`);
      return;
    }

    case 'proxies': {
      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const proxyPool = new ProxyPool({ projectRoot: cwd });
      const items = await proxyPool.list();
      process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      return;
    }

    case 'proxy-enable':
    case 'proxy-disable':
    case 'proxy-reset':
    case 'proxy-note':
    case 'proxy-probe': {
      if (!maybeTarget) {
        printHelp();
        process.exitCode = 1;
        return;
      }

      const cwd = options.cwd ? resolve(String(options.cwd)) : process.cwd();
      const proxyPool = new ProxyPool({ projectRoot: cwd });
      let item = null;

      if (command === 'proxy-enable') {
        item = await proxyPool.setEnabled(maybeTarget, true);
      } else if (command === 'proxy-disable') {
        item = await proxyPool.setEnabled(maybeTarget, false);
      } else if (command === 'proxy-reset') {
        item = await proxyPool.reset(maybeTarget);
      } else if (command === 'proxy-note') {
        if (!options.text) {
          throw new Error('--text is required');
        }
        item = await proxyPool.updateNotes(maybeTarget, String(options.text));
      } else {
        const result = await proxyPool.probe(maybeTarget, {
          targetUrl: options.url ? String(options.url) : undefined,
          timeoutMs: options.timeoutMs ? Number(options.timeoutMs) : undefined,
        });
        if (!result) {
          throw new Error('proxy not found');
        }
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      if (!item) {
        throw new Error('proxy not found');
      }

      process.stdout.write(`${JSON.stringify(item, null, 2)}\n`);
      return;
    }

    case 'scaffold': {
      const targetPath = resolve(process.cwd(), maybeTarget ?? 'examples/starter.workflow.json');
      await ensureDir(dirname(targetPath));
      await writeJson(targetPath, starterWorkflow());
      process.stdout.write(`${targetPath}\n`);
      return;
    }

    case 'capabilities': {
      process.stdout.write(`${JSON.stringify(getCapabilities(), null, 2)}\n`);
      return;
    }

    case 'integrations': {
      process.stdout.write(`${JSON.stringify(inspectOptionalIntegrations(), null, 2)}\n`);
      return;
    }

    case 'integration-probe': {
      const dryRun = String(options['dry-run'] ?? 'true').toLowerCase() !== 'false';
      const timeoutMs = options.timeoutMs ? Number(options.timeoutMs) : 3000;
      const config = options['config-json'] ? JSON.parse(String(options['config-json'])) : {};

      if (options.all === true) {
        const result = await probeIntegrations({
          dryRun,
          timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 3000,
          configs: config && typeof config === 'object' ? config : {},
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      if (!maybeTarget) {
        printHelp();
        process.exitCode = 1;
        return;
      }

      const result = await probeIntegration({
        id: String(maybeTarget),
        dryRun,
        timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 3000,
        config: config && typeof config === 'object' ? config : {},
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;

    default:
      printHelp();
      process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runCommand(process.argv.slice(2)).catch((error) => {
    logger.error('command failed', {
      error: error?.message ?? String(error),
    });
    process.exitCode = 1;
  });
}
