import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const BACKEND_CATALOG = [
  {
    name: 'patchright',
    packageName: 'patchright',
    family: 'playwright',
    priority: 300,
    aliases: ['patchright', 'patchright-chromium'],
    resolveLauncher(mod) {
      return mod?.chromium ?? null;
    },
  },
  {
    name: 'playwright',
    packageName: 'playwright',
    family: 'playwright',
    priority: 200,
    aliases: ['playwright', 'playwright-chromium', 'pw'],
    resolveLauncher(mod) {
      return mod?.chromium ?? null;
    },
  },
  {
    name: 'playwright-core',
    packageName: 'playwright-core',
    family: 'playwright',
    priority: 150,
    aliases: ['playwright-core', 'pw-core'],
    resolveLauncher(mod) {
      return mod?.chromium ?? null;
    },
  },
  {
    name: 'puppeteer',
    packageName: 'puppeteer',
    family: 'puppeteer',
    priority: 100,
    aliases: ['puppeteer', 'pptr', 'chromium'],
    resolveLauncher(mod) {
      return mod?.launch ? mod : null;
    },
  },
  {
    name: 'puppeteer-core',
    packageName: 'puppeteer-core',
    family: 'puppeteer',
    priority: 90,
    aliases: ['puppeteer-core', 'pptr-core'],
    resolveLauncher(mod) {
      return mod?.launch ? mod : null;
    },
  },
];

function tryRequire(id) {
  try {
    return require(id);
  } catch {
    return null;
  }
}

function normalizeEngineName(value = 'auto') {
  return String(value ?? 'auto').trim().toLowerCase() || 'auto';
}

function resolveBundledExecutablePath(launcher) {
  try {
    const executablePath = launcher?.executablePath?.();
    return typeof executablePath === 'string' && executablePath ? executablePath : null;
  } catch {
    return null;
  }
}

export function isBrowserBackendDefaultReady(backend, { executablePath } = {}) {
  if (!backend?.launcher) {
    return false;
  }

  if (typeof executablePath === 'string' && executablePath.trim()) {
    return true;
  }

  if (backend.name === 'playwright-core' || backend.name === 'puppeteer-core') {
    return false;
  }

  const bundledExecutablePath = backend.bundledExecutablePath ?? resolveBundledExecutablePath(backend.launcher);
  if (!bundledExecutablePath) {
    return backend.name === 'patchright';
  }

  return existsSync(bundledExecutablePath);
}

export function normalizeBrowserEngine(engine) {
  const normalized = normalizeEngineName(engine);
  if (normalized === 'default') {
    return 'auto';
  }

  for (const backend of BACKEND_CATALOG) {
    if (backend.aliases.includes(normalized)) {
      return backend.name;
    }
  }

  return normalized;
}

export function getBrowserBackendCatalog() {
  return BACKEND_CATALOG.map((backend) => {
    const mod = tryRequire(backend.packageName);
    const launcher = backend.resolveLauncher(mod);
    const bundledExecutablePath = launcher ? resolveBundledExecutablePath(launcher) : null;
    return {
      name: backend.name,
      packageName: backend.packageName,
      family: backend.family,
      aliases: [...backend.aliases],
      priority: backend.priority,
      available: Boolean(launcher),
      bundledExecutablePath,
      defaultReady: launcher
        ? isBrowserBackendDefaultReady({
            ...backend,
            launcher,
            bundledExecutablePath,
          })
        : false,
      launcher: launcher ?? null,
    };
  });
}

export function getAvailableBrowserBackends(options = {}) {
  return getBrowserBackendCatalog()
    .filter((backend) => backend.available)
    .map((backend) => ({
      ...backend,
      defaultReady: isBrowserBackendDefaultReady(backend, options),
    }))
    .sort((left, right) => {
      if (left.defaultReady !== right.defaultReady) {
        return left.defaultReady ? -1 : 1;
      }
      return right.priority - left.priority || left.name.localeCompare(right.name);
    });
}

export function resolveBrowserBackend(engine, options = {}) {
  const preferred = normalizeBrowserEngine(engine);
  const available = getAvailableBrowserBackends(options);

  if (preferred === 'auto') {
    return available[0] ?? null;
  }

  return available.find((item) => item.name === preferred || item.aliases.includes(preferred)) ?? null;
}
