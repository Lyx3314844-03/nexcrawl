import { getUrlPathExtension } from '../utils/url.js';

/**
 * 负责作业中的发现逻辑 (URL 分类与提取规则)
 */
export class JobDiscovery {
  constructor(workflow) {
    this.workflow = workflow;
    this.includePatterns = (workflow.discovery.include ?? []).map(p => new RegExp(p));
    this.excludePatterns = (workflow.discovery.exclude ?? []).map(p => new RegExp(p));
  }

  /**
   * 对发现的 URL 进行自动分类
   */
  classify(candidate, { paginationUrl = null } = {}) {
    const url = candidate.url.toLowerCase();
    
    if ((paginationUrl && candidate.url === paginationUrl)) {
      return 'pagination';
    }

    if (/\/api(\/|$)|[?&](api|format)=/i.test(url)) {
      return 'api';
    }

    if (/\/(product|products|item|items|detail|details|dp)\/|\/p\/[a-z0-9_-]+/i.test(url)) {
      return 'detail';
    }

    if (/\b(next|next page|older|more|load more|下一页|更多)\b/i.test(candidate.text ?? '')) {
      return 'pagination';
    }

    return 'generic';
  }

  /**
   * 根据响应类型自动生成发现规则
   */
  getAutoRule(response) {
    const contentType = (response.headers['content-type'] || '').toLowerCase();
    
    if (contentType.includes('xml') || contentType.includes('sitemap')) {
      return {
        type: 'xpath',
        xpath: '//url/loc/text() | //sitemap/loc/text()'
      };
    }
    
    return {
      type: 'links',
      selector: 'a[href]'
    };
  }

  isAllowed(url) {
    if (this.excludePatterns.some(p => p.test(url))) return false;
    if (this.includePatterns.length > 0) {
      return this.includePatterns.some(p => p.test(url));
    }
    return true;
  }
}
