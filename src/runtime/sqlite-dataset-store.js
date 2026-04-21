export class SqliteDatasetStore {
  constructor({ datasetId, metadata = {}, dataPlane } = {}) {
    if (!datasetId) {
      throw new Error('datasetId is required');
    }

    this.datasetId = datasetId;
    this.metadata = metadata;
    this.dataPlane = dataPlane;
  }

  static async list({ dataPlane, limit = 100 } = {}) {
    await dataPlane.init();
    return dataPlane.listDatasets(limit);
  }

  static async get({ dataPlane, datasetId } = {}) {
    await dataPlane.init();
    return dataPlane.getDataset(datasetId);
  }

  static async listItems({ dataPlane, datasetId, offset = 0, limit = 50, query = '' } = {}) {
    await dataPlane.init();
    return dataPlane.listDatasetItems(datasetId, { offset, limit, query });
  }

  async init() {
    await this.dataPlane.init();
    this.dataPlane.ensureDataset(this.datasetId, this.metadata);
    return this;
  }

  async addItem(item) {
    await this.init();
    return this.dataPlane.addDatasetItem(this.datasetId, item);
  }

  async getInfo() {
    await this.init();
    return this.dataPlane.getDataset(this.datasetId);
  }

  async listItems({ offset = 0, limit = 50, query = '' } = {}) {
    await this.init();
    return this.dataPlane.listDatasetItems(this.datasetId, { offset, limit, query });
  }

  async setMetadata(metadata) {
    await this.init();
    return this.dataPlane.setDatasetMetadata(this.datasetId, metadata);
  }
}
