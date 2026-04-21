/**
 * PluginRegistry - Community plugin discovery and loading system.
 *
 * Provides a registry for third-party plugins, NPM-based discovery,
 * and structured loading/lifecycle management.
 *
 * Equivalent to Scrapy's middleware/pipeline ecosystem and Crawlee's
 * plugin architecture.  Supports local file plugins, npm packages,
 * and inline factory functions.
 *
 * Usage:
 *   const registry = new PluginRegistry();
 *   registry.register('my-plugin', () => ({ name: 'my-plugin', beforeRequest: ... }));
 *   const plugin = await registry.load('my-plugin');
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../core/logger.js';

const log = createLogger('plugin-registry');

/**
 * @typedef {Object} PluginEntry
 * @property {string} name - Unique plugin identifier
 * @property {string} [version] - Plugin version
 * @property {string} [description] - Plugin description
 * @property {string} [author] - Plugin author
 * @property {string} [homepage] - Plugin homepage URL
 * @property {Function} factory - Factory function that creates the plugin instance
 * @property {string} [source] - Where the plugin was registered from ('local' | 'npm' | 'inline')
 */

export class PluginRegistry {
  constructor() {
    /** @type {Map<string, PluginEntry>} */
    this.entries = new Map();
    /** @type {Map<string, Object>} */
    this.instances = new Map();
  }

  /**
   * Register a plugin by its factory function.
   *
   * @param {string} name - Unique plugin name
   * @param {Function} factory - async () => OmniPlugin instance
   * @param {Object} [meta] - Plugin metadata
   * @returns {PluginRegistry} this (for chaining)
   */
  register(name, factory, meta = {}) {
    if (this.entries.has(name)) {
      log.warn('Overwriting existing plugin registration', { name });
    }

    this.entries.set(name, {
      name,
      version: meta.version || '0.0.0',
      description: meta.description || '',
      author: meta.author || '',
      homepage: meta.homepage || '',
      factory,
      source: meta.source || 'inline',
    });

    return this;
  }

  /**
   * Unregister a plugin.
   * @param {string} name
   * @returns {boolean}
   */
  unregister(name) {
    this.instances.delete(name);
    return this.entries.delete(name);
  }

  /**
   * Load and instantiate a registered plugin.
   *
   * @param {string} name - Plugin name
   * @param {Object} [options] - Options passed to the factory
   * @returns {Promise<Object>} The plugin instance
   */
  async load(name, options = {}) {
    // Return cached instance if available
    if (this.instances.has(name)) {
      return this.instances.get(name);
    }

    const entry = this.entries.get(name);
    if (!entry) {
      throw new Error(`Plugin not found: ${name}. Available: ${[...this.entries.keys()].join(', ')}`);
    }

    try {
      const plugin = await entry.factory(options);
      if (!plugin || typeof plugin !== 'object') {
        throw new Error(`Plugin factory returned invalid object for: ${name}`);
      }
      if (plugin.name !== name) {
        log.warn('Plugin name mismatch', { registered: name, actual: plugin.name });
      }

      this.instances.set(name, plugin);
      log.info('Loaded plugin', { name, version: entry.version });
      return plugin;
    } catch (err) {
      throw new Error(`Failed to load plugin ${name}: ${err.message}`);
    }
  }

  /**
   * Load a plugin from an NPM package.
   *
   * @param {string} packageName - NPM package name (e.g. 'omnicrawl-plugin-sitemap')
   * @param {Object} [options] - Plugin options
   * @returns {Promise<Object>} The plugin instance
   */
  async loadFromNpm(packageName, options = {}) {
    try {
      const modulePath = await import(packageName);
      const factory = modulePath.default || modulePath.plugin || modulePath[packageName];

      if (typeof factory !== 'function') {
        throw new Error(`NPM package ${packageName} does not export a plugin factory`);
      }

      // Auto-register
      this.register(packageName, factory, { source: 'npm' });
      return this.load(packageName, options);
    } catch (err) {
      throw new Error(`Failed to load NPM plugin ${packageName}: ${err.message}`);
    }
  }

  /**
   * Load a plugin from a local file path.
   *
   * @param {string} filePath - Path to the plugin module
   * @param {Object} [options] - Plugin options
   * @returns {Promise<Object>} The plugin instance
   */
  async loadFromFile(filePath, options = {}) {
    const name = resolve(filePath).split('/').pop().replace('.js', '');

    try {
      const moduleUrl = pathToFileURL(resolve(filePath)).href;
      const moduleNamespace = await import(moduleUrl);
      const factory = moduleNamespace.default || moduleNamespace.plugin || moduleNamespace[name];

      if (typeof factory !== 'function') {
        throw new Error(`File ${filePath} does not export a plugin factory`);
      }

      this.register(name, factory, { source: 'local' });
      return this.load(name, options);
    } catch (err) {
      throw new Error(`Failed to load file plugin ${filePath}: ${err.message}`);
    }
  }

  /**
   * List all registered plugins.
   * @returns {PluginEntry[]}
   */
  list() {
    return [...this.entries.values()].map(entry => ({
      name: entry.name,
      version: entry.version,
      description: entry.description,
      author: entry.author,
      homepage: entry.homepage,
      source: entry.source,
      loaded: this.instances.has(entry.name),
    }));
  }

  /**
   * Check if a plugin is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this.entries.has(name);
  }

  /**
   * Get the number of registered plugins.
   */
  get size() {
    return this.entries.size;
  }
}

// ─── Built-in community plugins ────────────────────────────────────

/**
 * Sitemap XML parser plugin.
 * Discovers URLs from sitemap.xml files and enqueues them.
 */
export function createSitemapPlugin(options = {}) {
  return {
    name: 'sitemap',
    version: '1.0.0',
    description: 'Parse XML sitemaps and enqueue discovered URLs',

    async afterFetch({ request, response }) {
      const contentType = response.headers?.['content-type'] ?? '';
      if (!contentType.includes('xml') && !request.url.includes('sitemap')) {
        return {};
      }

      const locations = [...String(response.body).matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
        .map(m => m[1].trim())
        .filter(Boolean);

      return { discoveredUrls: locations };
    },
  };
}

/**
 * JSON-LD structured data extractor plugin.
 * Extracts JSON-LD data from <script type="application/ld+json"> tags.
 */
export function createJsonLdPlugin(options = {}) {
  return {
    name: 'json-ld',
    version: '1.0.0',
    description: 'Extract JSON-LD structured data from HTML pages',

    async afterFetch({ request, response }) {
      if (!response.body) return { jsonLd: [] };

      const matches = [...String(response.body).matchAll(
        /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
      )];

      const jsonLd = [];
      for (const match of matches) {
        try {
          jsonLd.push(JSON.parse(match[1]));
        } catch { /* skip invalid JSON-LD */ }
      }

      return { jsonLd };
    },
  };
}

/**
 * Robots.txt enhancer plugin.
 * Adds robots.txt metadata to each request for WAF analysis.
 */
export function createRobotsMetaPlugin(options = {}) {
  const robotsCache = new Map();

  return {
    name: 'robots-meta',
    version: '1.0.0',
    description: 'Analyze robots.txt and add metadata to responses',

    async afterResponse({ request, response }) {
      const origin = new URL(request.url).origin;
      if (!robotsCache.has(origin)) {
        try {
          const robotsUrl = new URL('/robots.txt', origin).href;
          const resp = await fetch(robotsUrl, { signal: AbortSignal.timeout(5000) });
          if (resp.ok) {
            robotsCache.set(origin, await resp.text());
          }
        } catch {
          robotsCache.set(origin, null);
        }
      }

      return { robotsTxtAvailable: robotsCache.get(origin) !== null };
    },
  };
}

// ─── Registry singleton ────────────────────────────────────────────

const globalRegistry = new PluginRegistry();

// Register built-in community plugins
globalRegistry.register('sitemap', createSitemapPlugin, {
  version: '1.0.0',
  description: 'Parse XML sitemaps and enqueue discovered URLs',
  source: 'builtin',
});

globalRegistry.register('json-ld', createJsonLdPlugin, {
  version: '1.0.0',
  description: 'Extract JSON-LD structured data from HTML pages',
  source: 'builtin',
});

globalRegistry.register('robots-meta', createRobotsMetaPlugin, {
  version: '1.0.0',
  description: 'Analyze robots.txt and add metadata to responses',
  source: 'builtin',
});

/**
 * Get the global plugin registry singleton.
 * @returns {PluginRegistry}
 */
export function getGlobalRegistry() {
  return globalRegistry;
}

export default PluginRegistry;
