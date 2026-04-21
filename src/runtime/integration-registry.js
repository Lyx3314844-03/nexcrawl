import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const OPTIONAL_INTEGRATIONS = [
  {
    id: 'redis',
    label: 'Redis',
    packageName: 'ioredis',
    category: 'queue-control-plane',
    envKeys: ['OMNICRAWL_REDIS_URL', 'REDIS_URL'],
    docs: 'Distributed control plane, queues, and worker coordination',
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    packageName: 'pg',
    category: 'database',
    envKeys: ['OMNICRAWL_POSTGRES_URL', 'DATABASE_URL'],
    docs: 'Database sink for exported crawl records',
  },
  {
    id: 'mysql',
    label: 'MySQL',
    packageName: 'mysql2',
    category: 'database',
    envKeys: ['OMNICRAWL_MYSQL_HOST', 'MYSQL_HOST'],
    docs: 'Database sink for exported crawl records',
  },
  {
    id: 'mongodb',
    label: 'MongoDB',
    packageName: 'mongodb',
    category: 'database',
    envKeys: ['OMNICRAWL_MONGODB_URL', 'MONGODB_URL'],
    docs: 'Document sink for exported crawl records',
  },
  {
    id: 'smtp',
    label: 'SMTP Email',
    packageName: 'nodemailer',
    category: 'alerting',
    envKeys: ['OMNICRAWL_SMTP_HOST', 'SMTP_HOST'],
    docs: 'Email alert delivery',
  },
  {
    id: 's3',
    label: 'Amazon S3',
    packageName: '@aws-sdk/client-s3',
    category: 'cloud-storage',
    envKeys: ['AWS_ACCESS_KEY_ID', 'AWS_PROFILE', 'AWS_REGION'],
    docs: 'S3 or S3-compatible object storage sink',
  },
  {
    id: 'gcs',
    label: 'Google Cloud Storage',
    packageName: '@google-cloud/storage',
    category: 'cloud-storage',
    envKeys: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'],
    docs: 'GCS object storage sink',
  },
  {
    id: 'azure',
    label: 'Azure Blob Storage',
    packageName: '@azure/storage-blob',
    category: 'cloud-storage',
    envKeys: ['AZURE_STORAGE_CONNECTION_STRING'],
    docs: 'Azure blob storage sink',
  },
  { id: "elasticsearch", label: "Elasticsearch", packageName: "@elastic/elasticsearch", category: "search-engine", envKeys: ["ELASTICSEARCH_NODE"], docs: "Elasticsearch data sink for full-text search indexing" },
  { id: "kafka", label: "Apache Kafka", packageName: "kafkajs", category: "message-queue", envKeys: ["KAFKA_BROKERS", "KAFKA_TOPIC"], docs: "Kafka topic sink for high-throughput streaming" },
  { id: "webhook", label: "Webhook", packageName: "node-fetch", category: "notification", envKeys: ["WEBHOOK_URL"], docs: "HTTP webhook sink for push notifications and integrations" },
  { id: "socks5", label: "SOCKS5/Tor Proxy", packageName: "socks-proxy-agent", category: "proxy", envKeys: ["SOCKS5_PROXY", "TOR_CONTROL_PORT"], docs: "SOCKS5 and Tor anonymous proxy support" },
  { id: "cron-parser", label: "Cron Parser", packageName: "cron-parser", category: "scheduling", envKeys: ["CRON_EXPRESSION"], docs: "Cron expression parser for scheduled crawl jobs" },
];

function findIntegration(id) {
  return OPTIONAL_INTEGRATIONS.find((entry) => entry.id === id) ?? null;
}

function packageAvailable(packageName) {
  try {
    require.resolve(packageName);
    return true;
  } catch {
    return false;
  }
}

function packageVersion(packageName) {
  try {
    return require(`${packageName}/package.json`).version ?? null;
  } catch {
    return null;
  }
}

function envConfigured(env, keys = []) {
  return keys.some((key) => {
    const value = env?.[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function probeShape(integration, env = process.env) {
  const installed = packageAvailable(integration.packageName);
  return {
    id: integration.id,
    label: integration.label,
    category: integration.category,
    packageName: integration.packageName,
    installed,
    packageVersion: installed ? packageVersion(integration.packageName) : null,
    envConfigured: envConfigured(env, integration.envKeys),
    envKeys: integration.envKeys,
    docs: integration.docs,
  };
}

function validateProbeConfig(id, config = {}) {
  switch (id) {
    case 'redis':
      return {
        configValid: Boolean(
          (typeof config.url === 'string' && config.url.trim())
          || (typeof config.host === 'string' && config.host.trim()),
        ),
        required: ['url or host'],
      };
    case 'postgres':
      return {
        configValid: typeof config.connectionString === 'string' && config.connectionString.trim().length > 0,
        required: ['connectionString'],
      };
    case 'mysql':
      return {
        configValid: ['host', 'user', 'database'].every((key) => typeof config[key] === 'string' && config[key].trim().length > 0),
        required: ['host', 'user', 'database'],
      };
    case 'mongodb':
      return {
        configValid: typeof config.connectionString === 'string' && config.connectionString.trim().length > 0,
        required: ['connectionString'],
      };
    case 'smtp':
      return {
        configValid: typeof config.host === 'string' && config.host.trim().length > 0,
        required: ['host'],
      };
    case 's3':
      return {
        configValid: ['bucket', 'region'].every((key) => typeof config[key] === 'string' && config[key].trim().length > 0),
        required: ['bucket', 'region'],
      };
    case 'gcs':
      return {
        configValid: typeof config.bucket === 'string' && config.bucket.trim().length > 0,
        required: ['bucket'],
      };
    case 'azure':
      return {
        configValid: ['connectionString', 'container'].every((key) => typeof config[key] === 'string' && config[key].trim().length > 0),
        required: ['connectionString', 'container'],
      };
    case 'elasticsearch':
      return { configValid: !!(config.node || config.url), required: ['node'] };
    case 'kafka':
      return { configValid: !!(config.brokers?.length && config.topic), required: ['brokers', 'topic'] };
    case 'webhook':
      return { configValid: !!config.url, required: ['url'] };
    case 'socks5':
      return { configValid: !!(config.host && config.port), required: ['host', 'port'] };
    case 'cron-parser':
      return { configValid: !!config.cron, required: ['cron'] };
    default:
      return {
        configValid: false,
        required: [],
      };
  }
}

async function probeRedis(config, timeoutMs) {
  const Redis = (await import('ioredis')).default;
  const client = config.url
    ? new Redis(config.url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: timeoutMs })
    : new Redis({
        host: config.host,
        port: Number(config.port ?? 6379),
        username: config.username,
        password: config.password,
        db: Number(config.db ?? 0),
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        connectTimeout: timeoutMs,
      });
  try {
    await client.connect();
    const pong = await client.ping();
    return { ok: pong === 'PONG', details: { pong } };
  } finally {
    client.disconnect();
  }
}

async function probePostgres(config) {
  const pg = await import('pg');
  const client = new pg.Client({ connectionString: config.connectionString });
  try {
    await client.connect();
    const result = await client.query('select 1 as ok');
    return { ok: result.rows?.[0]?.ok === 1, details: { rows: result.rowCount ?? 0 } };
  } finally {
    await client.end().catch(() => {});
  }
}

async function probeMySQL(config) {
  const mysql = await import('mysql2/promise');
  const connection = await mysql.createConnection({
    host: config.host,
    port: Number(config.port ?? 3306),
    user: config.user,
    password: config.password,
    database: config.database,
  });
  try {
    const [rows] = await connection.query('select 1 as ok');
    return { ok: Array.isArray(rows) && rows[0]?.ok === 1, details: { rows: Array.isArray(rows) ? rows.length : 0 } };
  } finally {
    await connection.end().catch(() => {});
  }
}

async function probeMongo(config) {
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(config.connectionString, { serverSelectionTimeoutMS: Number(config.timeoutMs ?? 3000) });
  try {
    await client.connect();
    const result = await client.db(config.database ?? 'admin').command({ ping: 1 });
    return { ok: result?.ok === 1, details: result };
  } finally {
    await client.close().catch(() => {});
  }
}

async function probeSmtp(config, timeoutMs) {
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: config.host,
    port: Number(config.port ?? 587),
    secure: Boolean(config.secure),
    auth: config.user || config.pass ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  const verified = await transport.verify();
  return { ok: verified === true, details: { verified } };
}

export function inspectOptionalIntegrations({ env = process.env } = {}) {
  const items = OPTIONAL_INTEGRATIONS.map((integration) => probeShape(integration, env));
  return {
    total: items.length,
    installedCount: items.filter((item) => item.installed).length,
    envConfiguredCount: items.filter((item) => item.envConfigured).length,
    items,
  };
}

export async function probeIntegration({ id, config = {}, dryRun = true, timeoutMs = 3000, env = process.env } = {}) {
  const integration = findIntegration(id);
  if (!integration) {
    return {
      id,
      ok: false,
      status: 'unknown-integration',
      message: 'integration is not registered',
    };
  }

  const shape = probeShape(integration, env);
  const { configValid, required } = validateProbeConfig(id, config);
  const startedAt = Date.now();

  if (dryRun) {
    return {
      ...shape,
      dryRun: true,
      ok: shape.installed && configValid,
      status: configValid
        ? (shape.installed ? 'dry-run-ready' : 'package-missing')
        : 'config-invalid',
      required,
      configValid,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!shape.installed) {
    return {
      ...shape,
      dryRun: false,
      ok: false,
      status: 'package-missing',
      required,
      configValid,
      durationMs: Date.now() - startedAt,
    };
  }

  if (!configValid) {
    return {
      ...shape,
      dryRun: false,
      ok: false,
      status: 'config-invalid',
      required,
      configValid,
      durationMs: Date.now() - startedAt,
    };
  }

  try {
    let result;
    switch (id) {
      case 'redis':
        result = await probeRedis(config, timeoutMs);
        break;
      case 'postgres':
        result = await probePostgres(config);
        break;
      case 'mysql':
        result = await probeMySQL(config);
        break;
      case 'mongodb':
        result = await probeMongo(config);
        break;
      case 'smtp':
        result = await probeSmtp(config, timeoutMs);
        break;
      case 's3':
      case 'gcs':
      case 'azure':
        result = {
          ok: true,
          details: {
            note: 'configuration shape validated; active remote probe is intentionally not performed automatically',
          },
        };
        break;
      default:
        result = { ok: false, details: { note: 'no probe implementation' } };
        break;
    }
    return {
      ...shape,
      dryRun: false,
      ok: result.ok === true,
      status: result.ok === true ? 'reachable' : 'probe-failed',
      required,
      configValid,
      details: result.details ?? null,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ...shape,
      dryRun: false,
      ok: false,
      status: 'probe-failed',
      required,
      configValid,
      error: error?.message ?? String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

export async function probeIntegrations({ ids = [], configs = {}, dryRun = true, timeoutMs = 3000, env = process.env } = {}) {
  const targetIds = ids.length > 0 ? ids : OPTIONAL_INTEGRATIONS.map((item) => item.id);
  const items = [];
  for (const id of targetIds) {
    items.push(await probeIntegration({
      id,
      config: configs[id] ?? {},
      dryRun,
      timeoutMs,
      env,
    }));
  }
  return {
    total: items.length,
    okCount: items.filter((item) => item.ok).length,
    items,
  };
}

export { OPTIONAL_INTEGRATIONS };
