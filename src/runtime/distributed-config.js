import { hostname } from 'node:os';
import { resolve } from 'node:path';

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function defaultWorkerId() {
  return `worker_${hostname().replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}_${process.pid}`;
}

export function resolveDistributedConfig({ projectRoot = process.cwd(), distributed } = {}) {
  const input = distributed ?? {};
  const backend = String(input.backend ?? process.env.OMNICRAWL_CONTROL_PLANE ?? '').trim().toLowerCase();
  const enabled = input.enabled === true || backend === 'sqlite' || backend === 'redis';

  if (!enabled) {
    return {
      enabled: false,
      backend: 'local',
    };
  }

  const leaseTtlMs = toPositiveInt(input.leaseTtlMs ?? process.env.OMNICRAWL_LEASE_TTL_MS, 20000);
  const heartbeatMs = toPositiveInt(
    input.heartbeatMs ?? process.env.OMNICRAWL_HEARTBEAT_MS,
    Math.max(1000, Math.floor(leaseTtlMs / 3)),
  );

  const config = {
    enabled: true,
    backend,
    workerId: String(input.workerId ?? process.env.OMNICRAWL_WORKER_ID ?? defaultWorkerId()),
    workerEnabled: input.workerEnabled !== false && String(process.env.OMNICRAWL_WORKER_ENABLED ?? 'true').toLowerCase() !== 'false',
    workerConcurrency: toPositiveInt(input.workerConcurrency ?? process.env.OMNICRAWL_WORKER_CONCURRENCY, 1),
    pollIntervalMs: toPositiveInt(input.pollIntervalMs ?? process.env.OMNICRAWL_WORKER_POLL_MS, 200),
    leaseTtlMs,
    heartbeatMs: Math.min(heartbeatMs, Math.max(1000, leaseTtlMs - 250)),
    schedulerPollMs: toPositiveInt(input.schedulerPollMs ?? process.env.OMNICRAWL_SCHEDULER_POLL_MS, 250),
    scheduleLeaseTtlMs: toPositiveInt(input.scheduleLeaseTtlMs ?? process.env.OMNICRAWL_SCHEDULE_LEASE_TTL_MS, leaseTtlMs),
    gcEnabled: input.gcEnabled === true || String(process.env.OMNICRAWL_GC_ENABLED ?? '').toLowerCase() === 'true',
    gcPollMs: toPositiveInt(input.gcPollMs ?? process.env.OMNICRAWL_GC_POLL_MS, 60_000),
    gcRetentionMs: toPositiveInt(input.gcRetentionMs ?? process.env.OMNICRAWL_GC_RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
    gcBatchSize: toPositiveInt(input.gcBatchSize ?? process.env.OMNICRAWL_GC_BATCH_SIZE, 100),
  };

  if (backend === 'redis') {
    config.redis = {
      host: String(input.redis?.host ?? process.env.OMNICRAWL_REDIS_HOST ?? '127.0.0.1'),
      port: toPositiveInt(input.redis?.port ?? process.env.OMNICRAWL_REDIS_PORT, 6379),
      password: String(input.redis?.password ?? process.env.OMNICRAWL_REDIS_PASSWORD ?? '') || null,
      db: toPositiveInt(input.redis?.db ?? process.env.OMNICRAWL_REDIS_DB, 0),
      keyPrefix: String(input.redis?.keyPrefix ?? process.env.OMNICRAWL_REDIS_KEY_PREFIX ?? 'omnicrawl:'),
    };
  } else {
    config.backend = 'sqlite';
    config.dbPath = resolve(projectRoot, String(input.dbPath ?? process.env.OMNICRAWL_CONTROL_PLANE_PATH ?? '.omnicrawl/control-plane.sqlite'));
  }

  return config;
}
