/**
 * URL 处理工具函数
 */

/**
 * 获取 URL 路径中的文件扩展名
 * @param {string} targetUrl 目标 URL
 * @returns {string} 扩展名（带点，小写）
 */
export function getUrlPathExtension(targetUrl) {
  try {
    const pathname = new URL(targetUrl).pathname;
    const lastSegment = pathname.split('/').filter(Boolean).at(-1) ?? '';
    const extensionIndex = lastSegment.lastIndexOf('.');
    if (extensionIndex <= 0) {
      return '';
    }

    return lastSegment.slice(extensionIndex).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 规范化 URL
 */
export function normalizeUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}
