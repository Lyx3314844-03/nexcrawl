import { fetchWithBrowser } from '../fetchers/browser-fetcher.js';
import { fetchWithHttp } from '../fetchers/http-fetcher.js';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function injectPickerScript(html, { targetUrl, sourceType }) {
  const script = `
<script>
(() => {
  const CHANNEL = 'omnicrawl-field-picker';
  let overlay = null;
  let label = null;

  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '2147483647';
    overlay.style.border = '2px solid #d95f02';
    overlay.style.background = 'rgba(217,95,2,0.12)';
    overlay.style.borderRadius = '8px';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);

    label = document.createElement('div');
    label.style.position = 'fixed';
    label.style.pointerEvents = 'none';
    label.style.zIndex = '2147483647';
    label.style.padding = '6px 10px';
    label.style.borderRadius = '999px';
    label.style.background = '#1f1a16';
    label.style.color = '#fff';
    label.style.font = '12px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace';
    label.style.display = 'none';
    document.body.appendChild(label);
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char);
  }

  function buildSelector(node) {
    if (!(node instanceof Element)) return '';
    if (node.id) return '#' + cssEscape(node.id);
    const segments = [];
    let current = node;
    while (current && current.nodeType === 1 && segments.length < 6) {
      let segment = current.tagName.toLowerCase();
      if (current.classList && current.classList.length > 0) {
        segment += '.' + Array.from(current.classList).slice(0, 2).map(cssEscape).join('.');
      }
      const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((entry) => entry.tagName === current.tagName) : [];
      if (siblings.length > 1) {
        segment += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
      }
      segments.unshift(segment);
      if (current.id) break;
      current = current.parentElement;
    }
    return segments.join(' > ');
  }

  function buildXPath(node) {
    if (!(node instanceof Element)) return '';
    const segments = [];
    let current = node;
    while (current && current.nodeType === 1) {
      let index = 1;
      let sibling = current.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === current.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      segments.unshift(current.tagName.toLowerCase() + '[' + index + ']');
      current = current.parentElement;
    }
    return '/' + segments.join('/');
  }

  function candidateAttributes(node) {
    if (!(node instanceof Element)) return [];
    const candidates = ['href', 'src', 'content', 'value', 'alt', 'title', 'name', 'data-testid'];
    return candidates
      .map((name) => ({ name, value: node.getAttribute(name) }))
      .filter((entry) => entry.value);
  }

  function describeNode(node) {
    return {
      tag: node.tagName.toLowerCase(),
      selector: buildSelector(node),
      xpath: buildXPath(node),
      text: (node.textContent || '').trim().slice(0, 240),
      html: (node.outerHTML || '').slice(0, 400),
      attributes: candidateAttributes(node),
      targetUrl: ${JSON.stringify(targetUrl)},
      sourceType: ${JSON.stringify(sourceType)},
    };
  }

  function moveOverlay(node) {
    ensureOverlay();
    if (!(node instanceof Element)) {
      overlay.style.display = 'none';
      label.style.display = 'none';
      return;
    }
    const rect = node.getBoundingClientRect();
    overlay.style.display = 'block';
    overlay.style.left = rect.left + 'px';
    overlay.style.top = rect.top + 'px';
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
    label.style.display = 'block';
    label.textContent = buildSelector(node) || node.tagName.toLowerCase();
    label.style.left = Math.max(8, rect.left) + 'px';
    label.style.top = Math.max(8, rect.top - 32) + 'px';
  }

  document.addEventListener('mouseover', (event) => {
    moveOverlay(event.target);
  }, true);

  document.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const detail = describeNode(event.target);
    try {
      window.opener?.postMessage({ channel: CHANNEL, detail }, window.location.origin);
    } catch {}
    try {
      window.parent?.postMessage({ channel: CHANNEL, detail }, window.location.origin);
    } catch {}
    const toast = document.createElement('div');
    toast.textContent = '已发送字段候选到控制台';
    toast.style.position = 'fixed';
    toast.style.right = '16px';
    toast.style.bottom = '16px';
    toast.style.zIndex = '2147483647';
    toast.style.padding = '10px 14px';
    toast.style.borderRadius = '12px';
    toast.style.background = '#1f1a16';
    toast.style.color = '#fff';
    toast.style.font = '14px/1.2 sans-serif';
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 1600);
  }, true);
})();
</script>`;

  const banner = `
<div style="position:sticky;top:0;z-index:2147483646;padding:10px 14px;background:#fff4df;border-bottom:1px solid #d5c7b1;font:13px/1.4 sans-serif;color:#201a16">
  字段点选模式：鼠标悬停高亮元素，点击后会把 selector / xpath / text 候选发送回 OmniCrawl 控制台。
</div>`;

  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body([^>]*)>/i, `<body$1>${banner}`)
      .replace(/<\/body>/i, `${script}</body>`);
  }

  return `<!doctype html><html><head><meta charset="utf-8" /><base href="${escapeHtml(targetUrl)}" /></head><body>${banner}${html}${script}</body></html>`;
}

export async function renderFieldPickerDocument({
  url,
  sourceType = 'static-page',
  renderWaitMs = 800,
} = {}) {
  if (!url) {
    throw new Error('url is required');
  }

  const request = {
    url,
    method: 'GET',
    headers: {
      'user-agent': 'OmniCrawlFieldPicker/1.0',
    },
    timeoutMs: 45000,
  };

  const response =
    sourceType === 'browser-rendered'
      ? await fetchWithBrowser(request, {
          headless: true,
          waitUntil: 'networkidle2',
          sleepMs: renderWaitMs,
          debug: {
            enabled: false,
          },
        })
      : await fetchWithHttp(request);

  const baseHref = `<base href="${escapeHtml(response.finalUrl)}" />`;
  const htmlWithBase = /<head[^>]*>/i.test(response.body)
    ? response.body.replace(/<head([^>]*)>/i, `<head$1>${baseHref}`)
    : `<!doctype html><html><head>${baseHref}<meta charset="utf-8" /></head><body>${response.body}</body></html>`;

  return injectPickerScript(htmlWithBase, {
    targetUrl: response.finalUrl,
    sourceType,
  });
}
