import { getLogger } from '../utils/logger.js';
import { z } from 'zod';

const logger = getLogger('data-validator');

/**
 * 数据校验与清洗中间件
 * 解决：入库前的“垃圾数据”拦截问题
 */
export class DataValidator {
  constructor(schema) {
    this.schema = schema; // 期待一个 Zod schema 或类似的验证定义
  }

  /**
   * 验证并清洗数据
   */
  async validate(data) {
    try {
      const validatedData = this.schema.parse(data);
      return { ok: true, data: validatedData };
    } catch (error) {
      logger.error('Data validation failed', { 
        errors: error.errors,
        raw: data 
      });
      return { ok: false, error: error.message };
    }
  }
}

/**
 * 快捷函数：为 Crawler 开启强制校验模式
 */
export function useDataValidation(crawler, schema) {
  const validator = new DataValidator(schema);
  crawler.on('itemExtracted', async (item, ctx) => {
    const result = await validator.validate(item);
    if (!result.ok) {
      ctx.abort('invalid-data'); // 阻断下游写入
    }
  });
}
