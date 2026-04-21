import { getLogger } from '../utils/logger.js';
import { aiAnalysis } from '../reverse/ai-analysis.js';
import { zod } from 'zod'; // 框架已有依赖

const logger = getLogger('ai-extractor');

/**
 * AI Semantic Extraction Engine
 * Solves the pain point of brittle XPath/CSS selectors by automatically understanding page structure.
 */
export class AiExtractor {
  constructor(options = {}) {
    this.model = options.model || 'gemini-1.5-pro';
    this.temperature = options.temperature || 0.1;
  }

  /**
   * Extract data according to specified Schema
   * @param {string} html Webpage source
   * @param {object} schemaData Zod or JSON Schema definition
   */
  async extract(html, schemaData) {
    logger.info('Starting AI semantic extraction...', { model: this.model });

    // 1. Clean HTML to reduce Token consumption (remove script, style, etc.)
    const cleanHtml = this._preprocessHtml(html);

    const prompt = `
      You are an expert data scraper. Extract the following information from the HTML provided.
      Return ONLY a valid JSON object matching this structure:
      ${JSON.stringify(schemaData, null, 2)}

      HTML Content:
      ---
      ${cleanHtml.substring(0, 15000)} 
      ---
    `;

    try {
      // 复用已有的 ai-analysis 基础设施进行推理
      const result = await aiAnalysis.reason(prompt, {
        jsonMode: true,
        temperature: this.temperature
      });

      return result;
    } catch (error) {
      logger.error('AI Extraction failed', { error: error.message });
      throw error;
    }
  }

  _preprocessHtml(html) {
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

/**
 * 快捷函数：直接在 Crawler 上链式调用
 */
export function useAiExtraction(crawler, schema) {
  crawler.on('requestFinished', async (ctx) => {
    const extractor = new AiExtractor();
    const data = await extractor.extract(ctx.body, schema);
    ctx.state.aiExtracted = data;
    await ctx.pushData(data);
  });
  return crawler;
}
