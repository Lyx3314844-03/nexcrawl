import { hashText } from '../utils/hash.js';
import { slugify } from '../utils/slug.js';

function safeRecordName(key, extension = '.json') {
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `${slugify(key) || 'record'}-${hashText(key).slice(0, 12)}${ext}`;
}

export class SqliteKeyValueStore {
  constructor({ storeId, metadata = {}, dataPlane } = {}) {
    if (!storeId) {
      throw new Error('storeId is required');
    }

    this.storeId = storeId;
    this.metadata = metadata;
    this.dataPlane = dataPlane;
  }

  static async list({ dataPlane, limit = 100 } = {}) {
    await dataPlane.init();
    return dataPlane.listKeyValueStores(limit);
  }

  static async get({ dataPlane, storeId } = {}) {
    await dataPlane.init();
    return dataPlane.getKeyValueStore(storeId);
  }

  static async getRecord({ dataPlane, storeId, key } = {}) {
    await dataPlane.init();
    return dataPlane.getRecord(storeId, key);
  }

  async init() {
    await this.dataPlane.init();
    this.dataPlane.ensureKeyValueStore(this.storeId, this.metadata);
    return this;
  }

  async setRecord(key, value, { contentType = 'application/json' } = {}) {
    await this.init();
    return this.dataPlane.setRecord(this.storeId, key, value, {
      contentType,
      fileName: safeRecordName(key, contentType === 'application/json' ? '.json' : '.txt'),
    });
  }

  async getInfo() {
    await this.init();
    return this.dataPlane.getKeyValueStore(this.storeId);
  }

  async listRecords() {
    await this.init();
    return this.dataPlane.listRecords(this.storeId);
  }

  async getRecord(key) {
    await this.init();
    return this.dataPlane.getRecord(this.storeId, key);
  }

  async setMetadata(metadata) {
    await this.init();
    return this.dataPlane.setKeyValueMetadata(this.storeId, metadata);
  }
}
