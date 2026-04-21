import { getLogger } from '../utils/logger.js';
import { aiAnalysis } from '../reverse/ai-analysis.js';

const logger = getLogger('ai-extractor');

export class AiExtractor {
  constructor(options = {}) {
    this.model = options.model || 'gemini-1.5-pro';
    this.tokenLimit = options.tokenLimit || 32000;
  }

  async extract(html, schema) {
    logger.info('Performing semantic extraction...', { model: this.model });
    
    // 1. 深度压缩 DOM：仅保留关键属性 (id, class, title, data-*)，移除冗余
    const semanticContent = this._compressDom(html);
    
    const prompt = `
      Extract data into JSON from the HTML provided below. 
      Schema: ${JSON.stringify(schema)}
      
      Constraint: 
      - If multiple items exist, return an array.
      - If data is missing, use null.
      - Resolve relative URLs using the provided base context.

      HTML Source:
      ${semanticContent.substring(0, this.tokenLimit)}
    `;

    return await aiAnalysis.reason(prompt, { jsonMode: true });
  }

  _compressDom(html) {
    // 移除所有 script, style, comments, and meta tags
    return html
      .replace(/<(script|style|meta|link|svg)\b[^>]*>([\s\S]*?)<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/ (?:id|class|data-[a-z0-9-]+)="[^"]*"/gi, (match) => match) // 保留属性
      .trim();
  }
}
