/**
 * Configuration Management — Unified config system for OmniCrawl.
 * Provides defaults, validation, and environment variable support.
 */

import { ConfigurationError } from '../errors.js';

const DEFAULT_CONFIG = {
  // Reverse Engineering
  reverse: {
    astCache: {
      enabled: true,
      maxSize: 100,
      ttl: 3600000, // 1 hour
    },
    sandbox: {
      vmTimeout: 10000,
      interceptNetwork: true,
      freezeTime: null,
    },
    optimizer: {
      maxPasses: 5,
      enabled: true,
    },
  },
  
  // Anti-Detection
  stealth: {
    fingerprint: {
      canvas: true,
      webgl: true,
      audio: true,
      fonts: true,
      noiseLevel: 3,
    },
    tlsProfile: 'chrome_120',
    behaviorSimulation: true,
  },
  
  // Security
  security: {
    validation: {
      maxCodeLength: 1000000,
      allowDangerousPatterns: false,
      allowPrivateIPs: false,
    },
    rateLimit: {
      enabled: true,
      maxRequests: 100,
      windowMs: 60000,
    },
  },
  
  // Performance
  performance: {
    concurrency: 10,
    timeout: 30000,
    retries: 3,
  },
};

class ConfigManager {
  constructor(userConfig = {}) {
    this.config = this._merge(DEFAULT_CONFIG, userConfig);
    this._validate();
  }

  _merge(defaults, user) {
    const result = { ...defaults };
    for (const [key, value] of Object.entries(user)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        result[key] = this._merge(defaults[key] || {}, value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  _validate() {
    // Validate critical settings
    if (this.config.performance.concurrency < 1) {
      throw new ConfigurationError('concurrency must be >= 1');
    }
    if (this.config.performance.timeout < 1000) {
      throw new ConfigurationError('timeout must be >= 1000ms');
    }
    if (this.config.reverse.astCache.maxSize < 1) {
      throw new ConfigurationError('astCache.maxSize must be >= 1');
    }
  }

  get(path) {
    const keys = path.split('.');
    let value = this.config;
    for (const key of keys) {
      value = value?.[key];
      if (value === undefined) return null;
    }
    return value;
  }

  set(path, value) {
    const keys = path.split('.');
    const lastKey = keys.pop();
    let target = this.config;
    
    for (const key of keys) {
      if (!target[key]) target[key] = {};
      target = target[key];
    }
    
    target[lastKey] = value;
    this._validate();
  }

  getAll() {
    return { ...this.config };
  }

  reset() {
    this.config = { ...DEFAULT_CONFIG };
  }
}

// Global singleton
let globalConfig = null;

export function getGlobalConfig() {
  if (!globalConfig) {
    globalConfig = new ConfigManager();
  }
  return globalConfig;
}

export function setGlobalConfig(userConfig) {
  globalConfig = new ConfigManager(userConfig);
  return globalConfig;
}

export function loadConfigFromEnv() {
  const config = {};
  
  // Parse environment variables
  if (process.env.OMNICRAWL_CONCURRENCY) {
    config.performance = { concurrency: parseInt(process.env.OMNICRAWL_CONCURRENCY) };
  }
  if (process.env.OMNICRAWL_TIMEOUT) {
    config.performance = { ...config.performance, timeout: parseInt(process.env.OMNICRAWL_TIMEOUT) };
  }
  if (process.env.OMNICRAWL_AST_CACHE === 'false') {
    config.reverse = { astCache: { enabled: false } };
  }
  
  return setGlobalConfig(config);
}

export { ConfigManager, DEFAULT_CONFIG };
