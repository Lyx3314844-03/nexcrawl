/**
 * Cloud storage sinks for S3, GCS, and Azure Blob.
 *
 * Design: adapter pattern — each provider exposes a unified uploadBuffer(key, buf, contentType)
 * interface. The ExportManager can call createCloudSink() to get a sink function compatible
 * with the existing 'sink' backend in export-manager.js.
 *
 * Dependencies are loaded lazily so the module doesn't hard-require cloud SDKs.
 * Install only what you need:
 *   npm install @aws-sdk/client-s3          # S3
 *   npm install @google-cloud/storage       # GCS
 *   npm install @azure/storage-blob         # Azure
 */

import { createLogger } from '../core/logger.js';

const log = createLogger('cloud-sink');

// ─── S3 ──────────────────────────────────────────────────────────────────────

/**
 * @param {Object} config
 * @param {string} config.bucket
 * @param {string} config.region
 * @param {string} [config.prefix] - Key prefix (folder path)
 * @param {string} [config.accessKeyId]
 * @param {string} [config.secretAccessKey]
 * @param {string} [config.endpoint] - Custom endpoint (MinIO, R2, etc.)
 * @param {boolean} [config.forcePathStyle]
 * @returns {{ upload(key: string, buf: Buffer, contentType: string): Promise<string> }}
 */
export async function createS3Adapter(config) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3').catch(() => {
    throw new Error('S3 sink requires @aws-sdk/client-s3: npm install @aws-sdk/client-s3');
  });

  const clientConfig = { region: config.region };
  if (config.accessKeyId) {
    clientConfig.credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };
  }
  if (config.endpoint) {
    clientConfig.endpoint = config.endpoint;
    clientConfig.forcePathStyle = config.forcePathStyle ?? true;
  }

  const client = new S3Client(clientConfig);
  const prefix = config.prefix ? config.prefix.replace(/\/$/, '') + '/' : '';

  return {
    async upload(key, buf, contentType = 'application/octet-stream') {
      const fullKey = prefix + key;
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: fullKey,
        Body: buf,
        ContentType: contentType,
      }));
      return `s3://${config.bucket}/${fullKey}`;
    },
  };
}

// ─── GCS ─────────────────────────────────────────────────────────────────────

/**
 * @param {Object} config
 * @param {string} config.bucket
 * @param {string} [config.prefix]
 * @param {string} [config.keyFilename] - Path to service account JSON
 * @param {string} [config.projectId]
 */
export async function createGCSAdapter(config) {
  const { Storage } = await import('@google-cloud/storage').catch(() => {
    throw new Error('GCS sink requires @google-cloud/storage: npm install @google-cloud/storage');
  });

  const storageOptions = {};
  if (config.keyFilename) storageOptions.keyFilename = config.keyFilename;
  if (config.projectId) storageOptions.projectId = config.projectId;

  const storage = new Storage(storageOptions);
  const bucket = storage.bucket(config.bucket);
  const prefix = config.prefix ? config.prefix.replace(/\/$/, '') + '/' : '';

  return {
    async upload(key, buf, contentType = 'application/octet-stream') {
      const fullKey = prefix + key;
      const file = bucket.file(fullKey);
      await file.save(buf, { contentType, resumable: false });
      return `gs://${config.bucket}/${fullKey}`;
    },
  };
}

// ─── Azure Blob ───────────────────────────────────────────────────────────────

/**
 * @param {Object} config
 * @param {string} config.connectionString - Azure storage connection string
 * @param {string} config.container
 * @param {string} [config.prefix]
 */
export async function createAzureBlobAdapter(config) {
  const { BlobServiceClient } = await import('@azure/storage-blob').catch(() => {
    throw new Error('Azure sink requires @azure/storage-blob: npm install @azure/storage-blob');
  });

  const serviceClient = BlobServiceClient.fromConnectionString(config.connectionString);
  const containerClient = serviceClient.getContainerClient(config.container);
  await containerClient.createIfNotExists().catch(() => {});
  const prefix = config.prefix ? config.prefix.replace(/\/$/, '') + '/' : '';

  return {
    async upload(key, buf, contentType = 'application/octet-stream') {
      const fullKey = prefix + key;
      const blockClient = containerClient.getBlockBlobClient(fullKey);
      await blockClient.uploadData(buf, {
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return `https://${containerClient.accountName}.blob.core.windows.net/${config.container}/${fullKey}`;
    },
  };
}

// ─── Unified sink factory ─────────────────────────────────────────────────────

/**
 * Create a cloud sink function compatible with ExportManager's 'sink' backend.
 *
 * @param {Object} options
 * @param {'s3'|'gcs'|'azure'} options.provider
 * @param {string} options.format - 'json' | 'jsonl' | 'csv'
 * @param {string} [options.keyTemplate] - e.g. 'crawl/{jobId}/{date}.jsonl'
 * @param {Object} options.providerConfig - passed to the provider adapter
 * @returns {Promise<Function>} sink(batch, context) => Promise<{insertedCount}>
 */
export async function createCloudSink(options) {
  const { provider, format = 'jsonl', keyTemplate, providerConfig } = options;

  let adapter;
  if (provider === 's3') adapter = await createS3Adapter(providerConfig);
  else if (provider === 'gcs') adapter = await createGCSAdapter(providerConfig);
  else if (provider === 'azure') adapter = await createAzureBlobAdapter(providerConfig);
  else throw new Error(`Unknown cloud provider: ${provider}. Use 's3', 'gcs', or 'azure'.`);

  const contentTypeMap = {
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    csv: 'text/csv',
  };
  const contentType = contentTypeMap[format] ?? 'application/octet-stream';
  const ext = format === 'jsonl' ? 'jsonl' : format;

  return async function cloudSink(batch, context = {}) {
    if (!batch?.length) return { insertedCount: 0 };

    const date = new Date().toISOString().slice(0, 10);
    const ts = Date.now();
    const jobId = context.jobId ?? 'unknown';
    const key = (keyTemplate ?? 'omnicrawl/{jobId}/{date}-{ts}.{ext}')
      .replace('{jobId}', jobId)
      .replace('{date}', date)
      .replace('{ts}', String(ts))
      .replace('{ext}', ext);

    let body;
    if (format === 'jsonl') {
      body = batch.map((item) => JSON.stringify(item)).join('\n');
    } else if (format === 'json') {
      body = JSON.stringify(batch, null, 2);
    } else if (format === 'csv') {
      const keys = Object.keys(batch[0] ?? {});
      const header = keys.join(',');
      const rows = batch.map((item) =>
        keys.map((k) => JSON.stringify(item[k] ?? '')).join(','),
      );
      body = [header, ...rows].join('\n');
    } else {
      body = JSON.stringify(batch);
    }

    const buf = Buffer.from(body, 'utf8');
    const uri = await adapter.upload(key, buf, contentType);
    log.info('cloud sink upload', { provider, uri, count: batch.length });

    return { insertedCount: batch.length, uri };
  };
}
