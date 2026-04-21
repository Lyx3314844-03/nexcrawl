/**
 * @callback PipelineStep
 * @param {Object} item - The extracted data item
 * @param {import('./crawl-context.js').CrawlContext} ctx - The crawl context
 * @returns {Promise<Object|void>} Return a modified item, or void/undefined/null to drop
 */

/**
 * ItemPipeline processes extracted data through a sequence of transforms
 * before it is persisted to the dataset store.
 *
 * @example
 * const pipeline = new ItemPipeline()
 *   .addStep(async (item) => { item.title = item.title.trim(); return item; })
 *   .addStep(validateRequiredFields)
 *   .addStep(async (item, ctx) => { ctx.log.info('pipeline output', { url: item._url }); return item; });
 */
export class ItemPipeline {
  constructor() {
    /** @private @type {PipelineStep[]} */
    this._steps = [];
    this._droppedCount = 0;
    this._processedCount = 0;
    this._errorCount = 0;
  }

  /**
   * Add a processing step to the pipeline.
   * Return a modified item to pass to the next step.
   * Return void/undefined/null to drop the item.
   * Throw an error to mark the item as failed.
   *
   * @param {PipelineStep} step
   * @returns {this}
   */
  addStep(step) {
    if (typeof step !== 'function') throw new TypeError('pipeline step must be a function');
    this._steps.push(step);
    return this;
  }

  /**
   * Process an item through all pipeline steps.
   * @param {Object} item
   * @param {import('./crawl-context.js').CrawlContext} ctx
   * @returns {Promise<{item: Object|null, dropped: boolean, error: Error|null}>}
   */
  async process(item, ctx) {
    let current = item;
    for (const step of this._steps) {
      try {
        const result = await step(current, ctx);
        if (result === null || result === undefined) {
          this._droppedCount++;
          return { item: null, dropped: true, error: null };
        }
        if (typeof result === 'object') current = result;
      } catch (error) {
        this._errorCount++;
        return { item: null, dropped: false, error };
      }
    }
    this._processedCount++;
    return { item: current, dropped: false, error: null };
  }

  /**
   * Get pipeline statistics.
   * @returns {Object}
   */
  stats() {
    return { steps: this._steps.length, processed: this._processedCount, dropped: this._droppedCount, errors: this._errorCount };
  }

  /**
   * Get a copy of the pipeline steps array.
   * @returns {PipelineStep[]}
   */
  steps() { return [...this._steps]; }

  /** Reset pipeline statistics. */
  reset() { this._droppedCount = 0; this._processedCount = 0; this._errorCount = 0; }
}
