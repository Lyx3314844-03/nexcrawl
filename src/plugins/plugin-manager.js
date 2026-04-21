import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeJson, ensureDir } from '../utils/fs.js';
import { slugify } from '../utils/slug.js';
import { buildRequestUniqueKey } from '../runtime/request-queue.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
];

function createDedupePlugin(_options = {}, context = {}) {
  const seen = new Set();

  return {
    name: 'dedupe',
    async beforeEnqueue({ item }) {
      const uniqueKey = buildRequestUniqueKey({
        ...item,
        method: item.method ?? context.workflow?.request?.method ?? 'GET',
        body: item.body ?? context.workflow?.request?.body,
      }, context.workflow?.requestQueue ?? {});
      if (seen.has(uniqueKey)) {
        return { skip: true, reason: 'duplicate-request' };
      }

      seen.add(uniqueKey);
      return { skip: false };
    },
  };
}

function createThrottlePlugin(options = {}) {
  const lastByHost = new Map();
  const delayMs = Number(options.delayMs ?? 200);

  return {
    name: 'throttle',
    async beforeRequest({ request }) {
      const host = new URL(request.url).host;
      const lastRunAt = lastByHost.get(host) ?? 0;
      const waitMs = Math.max(0, lastRunAt + delayMs - Date.now());

      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      lastByHost.set(host, Date.now());
    },
  };
}

function createAuditPlugin(options = {}, context) {
  let sequence = 0;

  return {
    name: 'audit',
    async afterFetch({ request, response }) {
      sequence += 1;

      const filePath = join(
        context.runDir,
        'snapshots',
        `${String(sequence).padStart(4, '0')}-${slugify(request.url)}.json`,
      );
      const payload = {
        request: {
          url: request.url,
          method: request.method,
          headers: request.headers,
        },
        response: {
          finalUrl: response.finalUrl,
          status: response.status,
          headers: response.headers,
          bodyPreview: response.body.slice(0, Number(options.previewBytes ?? 4096)),
        },
      };

      await ensureDir(join(context.runDir, 'snapshots'));
      await writeJson(filePath, payload);
      if (context.dataPlane && context.jobId) {
        context.dataPlane.writeJsonArtifact(
          context.jobId,
          `snapshots/${String(sequence).padStart(4, '0')}-${slugify(request.url)}.json`,
          payload,
        );
      }
    },
  };
}

function createRotateUserAgentPlugin() {
  let cursor = 0;

  return {
    name: 'rotateUserAgent',
    async beforeRequest({ request }) {
      request.headers = request.headers ?? {};
      request.headers['user-agent'] = USER_AGENTS[cursor % USER_AGENTS.length];
      cursor += 1;
    },
  };
}

const builtinFactories = {
  dedupe: createDedupePlugin,
  throttle: createThrottlePlugin,
  audit: createAuditPlugin,
  rotateUserAgent: createRotateUserAgentPlugin,
};

function resolveFactoryFromModule(moduleNamespace, pluginConfig) {
  if (pluginConfig.exportName && typeof moduleNamespace[pluginConfig.exportName] === 'function') {
    return moduleNamespace[pluginConfig.exportName];
  }

  if (typeof moduleNamespace.default === 'function') {
    return moduleNamespace.default;
  }

  if (typeof moduleNamespace.plugin === 'function') {
    return moduleNamespace.plugin;
  }

  if (typeof moduleNamespace[pluginConfig.name] === 'function') {
    return moduleNamespace[pluginConfig.name];
  }

  return null;
}

export class PluginManager {
  constructor(pluginConfigs = [], context = {}) {
    this.pluginConfigs = pluginConfigs;
    this.context = context;
    this.plugins = [];
  }

  async init() {
    this.plugins = [];

    for (const pluginConfig of this.pluginConfigs) {
      if (pluginConfig.path) {
        const modulePath = pathToFileURL(resolve(this.context.projectRoot ?? process.cwd(), pluginConfig.path)).href;
        const moduleNamespace = await import(modulePath);
        const factory = resolveFactoryFromModule(moduleNamespace, pluginConfig);

        if (typeof factory !== 'function') {
          throw new Error(`Plugin factory not found for ${pluginConfig.name} at ${pluginConfig.path}`);
        }

        const plugin = await factory(pluginConfig.options ?? {}, this.context);
        if (!plugin || typeof plugin !== 'object') {
          throw new Error(`Plugin factory returned invalid plugin for ${pluginConfig.name}`);
        }

        this.plugins.push(plugin);
        continue;
      }

      const factory = builtinFactories[pluginConfig.name];

      if (!factory) {
        throw new Error(`Unknown plugin: ${pluginConfig.name}`);
      }

      this.plugins.push(factory(pluginConfig.options, this.context));
    }

    return this;
  }

  async runHook(name, payload) {
    const aggregate = {};

    for (const plugin of this.plugins) {
      if (typeof plugin[name] !== 'function') {
        continue;
      }

      const result = await plugin[name](payload);

      if (result && typeof result === 'object') {
        Object.assign(aggregate, result);
        if (result.skip) {
          return aggregate;
        }
      }
    }

    return aggregate;
  }
}
