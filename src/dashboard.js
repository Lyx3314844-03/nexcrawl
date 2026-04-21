export function renderDashboard() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>OmniCrawl Control Panel</title>
    <style>
      :root {
        --bg: #f4efe6;
        --panel: #fffaf2;
        --line: #d5c7b1;
        --text: #201a16;
        --muted: #756454;
        --accent: #a44d2f;
        --accent-soft: #f4d7c9;
        --ok: #24754a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--text);
        background:
          radial-gradient(circle at top right, rgba(164,77,47,0.18), transparent 26%),
          radial-gradient(circle at bottom left, rgba(36,117,74,0.15), transparent 24%),
          linear-gradient(180deg, #faf4ea, var(--bg));
      }
      header {
        padding: 32px 24px 20px;
        border-bottom: 1px solid rgba(32,26,22,0.08);
      }
      h1 {
        margin: 0;
        font-size: 42px;
        line-height: 1;
        letter-spacing: -0.03em;
      }
      header p {
        max-width: 780px;
        margin: 12px 0 0;
        color: var(--muted);
        font-size: 16px;
      }
      main {
        width: min(1280px, calc(100% - 32px));
        margin: 20px auto 40px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 16px;
      }
      .panel {
        background: rgba(255,250,242,0.92);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 18px;
        box-shadow: 0 12px 30px rgba(32,26,22,0.05);
      }
      .panel h2 {
        margin: 0 0 12px;
        font-size: 20px;
      }
      .meta {
        color: var(--muted);
        font-size: 13px;
      }
      .pill {
        display: inline-block;
        padding: 4px 8px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        margin-right: 6px;
        margin-bottom: 6px;
      }
      .list {
        display: grid;
        gap: 10px;
      }
      .card {
        border: 1px solid rgba(32,26,22,0.08);
        border-radius: 14px;
        padding: 12px;
        background: rgba(255,255,255,0.65);
      }
      button {
        appearance: none;
        border: none;
        border-radius: 999px;
        background: var(--text);
        color: white;
        padding: 10px 14px;
        font-weight: 700;
        cursor: pointer;
      }
      button.secondary {
        background: #e7dcc9;
        color: var(--text);
      }
      form {
        display: grid;
        gap: 10px;
      }
      input, textarea {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.7);
        color: var(--text);
        font: inherit;
      }
      textarea {
        min-height: 180px;
        resize: vertical;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 13px;
      }
      select {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        background: rgba(255,255,255,0.7);
        color: var(--text);
        font: inherit;
      }
      label {
        display: grid;
        gap: 6px;
        color: var(--muted);
        font-size: 13px;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 12px;
      }
      .panel-wide {
        grid-column: 1 / -1;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 10px;
      }
      .template-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 10px;
        margin: 12px 0 16px;
      }
      .template-card {
        border: 1px solid rgba(32,26,22,0.08);
        border-radius: 16px;
        padding: 14px;
        background: rgba(255,255,255,0.66);
      }
      .template-card h3 {
        margin: 0 0 6px;
        font-size: 16px;
      }
      .template-card p {
        margin: 0 0 10px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }
      .hero {
        display: grid;
        gap: 10px;
      }
      .hero strong {
        font-size: 18px;
      }
      .inline-check {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--muted);
        font-size: 13px;
      }
      .inline-check input {
        width: auto;
      }
      .preview-box {
        min-height: 180px;
        border: 1px dashed var(--line);
        border-radius: 14px;
        padding: 12px;
        background: rgba(255,255,255,0.58);
        overflow: auto;
      }
      .status-ok { color: var(--ok); font-weight: 700; }
      .status-bad { color: #a42828; font-weight: 700; }
      code {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>OmniCrawl Control Panel</h1>
      <p>
        Register workflows, run them on demand, schedule recurring crawls, and inspect recent history from a single local control surface.
      </p>
    </header>
    <main>
      <section class="panel panel-wide">
        <div class="hero">
          <strong>零代码快速开始</strong>
          <div class="meta">
            不会写 workflow JSON 也可以先用。选模板、填网址、点运行，Dashboard 会自动生成一个可执行工作流；复杂需求再切到下面的高级编辑器。
          </div>
        </div>
        <div class="template-grid">
          <div class="template-card">
            <h3>静态网页</h3>
            <p>适合文章页、列表页、官网。默认提取标题、链接和页面表面信息。</p>
            <button type="button" class="secondary" onclick="applyQuickTemplate('static')">使用模板</button>
          </div>
          <div class="template-card">
            <h3>浏览器渲染页</h3>
            <p>适合需要执行 JavaScript 的页面，比如 SPA、前端渲染商城页。</p>
            <button type="button" class="secondary" onclick="applyQuickTemplate('browser')">使用模板</button>
          </div>
          <div class="template-card">
            <h3>JSON 接口</h3>
            <p>适合 API 返回 JSON 的接口。默认直接保留解析后的 JSON 结果。</p>
            <button type="button" class="secondary" onclick="applyQuickTemplate('api')">使用模板</button>
          </div>
          <div class="template-card">
            <h3>站点地图 / Feed</h3>
            <p>适合 sitemap.xml、RSS、Atom。用于快速拿 URL 和内容入口。</p>
            <button type="button" class="secondary" onclick="applyQuickTemplate('sitemap')">使用模板</button>
          </div>
        </div>
        <form id="quickStartForm">
          <div class="grid-2">
            <label>任务名称
              <input name="taskName" value="quick-start" placeholder="例如：news-homepage" />
            </label>
            <label>目标网址
              <input name="seedUrl" value="https://example.com" placeholder="https://example.com" required />
            </label>
            <label>页面类型
              <select name="sourceType">
                <option value="static-page">静态网页</option>
                <option value="browser-rendered">浏览器渲染网页</option>
                <option value="api-json">JSON 接口</option>
                <option value="sitemap">Sitemap / XML</option>
                <option value="feed">RSS / Atom Feed</option>
              </select>
            </label>
            <label>提取模板
              <select name="extractPreset">
                <option value="title-links">标题 + 链接</option>
                <option value="article">文章摘要</option>
                <option value="json-payload">JSON 全量结果</option>
                <option value="surface">页面表面分析</option>
              </select>
            </label>
            <label>抓取深度
              <input name="maxDepth" type="number" min="0" max="3" step="1" value="0" />
            </label>
            <label>最多发现页面数
              <input name="maxPages" type="number" min="1" max="200" step="1" value="20" />
            </label>
            <label>浏览器额外等待毫秒
              <input name="renderWaitMs" type="number" min="0" max="10000" step="100" value="800" />
            </label>
            <label>注册时的 workflow id
              <input name="workflowId" placeholder="可选，例如 news-homepage" />
            </label>
          </div>
          <div class="toolbar" style="margin-top:12px;">
            <label class="inline-check"><input id="quickUseSession" type="checkbox" checked />启用会话</label>
            <label class="inline-check"><input id="quickUseBrowserDebug" type="checkbox" checked />浏览器模式保留调试线索</label>
            <label class="inline-check"><input id="quickPersistBodies" type="checkbox" />保存页面正文</label>
          </div>
          <div class="toolbar">
            <button id="quickRunButton" type="button">一键运行</button>
            <button id="quickRegisterButton" type="button" class="secondary">注册为工作流</button>
            <button id="quickFillEditorButton" type="button" class="secondary">写入高级编辑器</button>
          </div>
        </form>
        <div id="quickStartStatus" class="meta" style="margin-top:10px;"></div>
        <div class="preview-box" id="quickWorkflowPreview" style="margin-top:12px;"></div>
      </section>

      <section class="panel panel-wide">
        <h2>字段点选器</h2>
        <div class="meta">
          打开页面快照后，直接点选元素，把 selector / xpath / 文本候选带回控制台，再一键填入字段预览助手。
        </div>
        <form id="fieldPickerForm" style="margin-top:12px;">
          <div class="grid-2">
            <label>目标网址
              <input name="url" value="https://example.com" placeholder="https://example.com" required />
            </label>
            <label>页面类型
              <select name="sourceType">
                <option value="static-page">静态网页</option>
                <option value="browser-rendered">浏览器渲染网页</option>
              </select>
            </label>
            <label>浏览器等待毫秒
              <input name="renderWaitMs" type="number" min="0" max="10000" step="100" value="800" />
            </label>
          </div>
          <div class="toolbar" style="margin-top:12px;">
            <button id="openFieldPickerButton" type="button">打开字段点选器</button>
          </div>
        </form>
        <div id="fieldPickerStatus" class="meta" style="margin-top:10px;"></div>
        <div class="preview-box" id="fieldPickerOutput" style="margin-top:12px;"></div>
      </section>

      <section class="panel panel-wide">
        <h2>字段预览助手</h2>
        <div class="meta">
          先试提取规则，再决定是否写进工作流。支持 CSS selector、XPath、JSON 路径、正则和 surface 分析。
        </div>
        <form id="extractPreviewForm" style="margin-top:12px;">
          <div class="grid-2">
            <label>目标网址
              <input name="url" value="https://example.com" placeholder="https://example.com" required />
            </label>
            <label>页面类型
              <select name="sourceType">
                <option value="static-page">静态网页</option>
                <option value="browser-rendered">浏览器渲染网页</option>
                <option value="api-json">JSON 接口</option>
              </select>
            </label>
            <label>规则类型
              <select name="ruleType">
                <option value="selector">CSS Selector</option>
                <option value="xpath">XPath</option>
                <option value="json">JSON Path</option>
                <option value="regex">Regex</option>
                <option value="surface">Surface</option>
              </select>
            </label>
            <label>规则名称
              <input name="ruleName" value="preview" placeholder="例如：title" />
            </label>
            <label>查询/路径/表达式
              <input name="ruleQuery" value="title" placeholder="selector / xpath / json path / regex" />
            </label>
            <label>属性名（selector 可选）
              <input name="attribute" placeholder="例如：href 或 content" />
            </label>
            <label>浏览器等待毫秒
              <input name="renderWaitMs" type="number" min="0" max="10000" step="100" value="800" />
            </label>
          </div>
          <div class="toolbar" style="margin-top:12px;">
            <label class="inline-check"><input id="extractPreviewAll" type="checkbox" />返回全部匹配项</label>
            <button type="submit">预览提取结果</button>
          </div>
        </form>
        <div id="extractPreviewStatus" class="meta" style="margin-top:10px;"></div>
        <div class="preview-box" id="extractPreviewOutput" style="margin-top:12px;"></div>
      </section>

      <section class="panel">
        <div class="toolbar">
          <button id="refreshButton" type="button">Refresh</button>
        </div>
        <h2>Health & Capabilities</h2>
        <div id="health" class="meta">Loading...</div>
        <div id="capabilities" style="margin-top:12px;"></div>
        <div id="historyHealth" class="list" style="margin-top:12px;"></div>
      </section>

      <section class="panel">
        <h2>Register Workflow</h2>
        <form id="workflowForm">
          <input name="workflowId" placeholder="Optional workflow id" />
          <textarea name="workflowJson">{\n  "name": "dashboard-demo",\n  "seedUrls": ["https://example.com"],\n  "mode": "http",\n  "concurrency": 1,\n  "maxDepth": 0,\n  "session": {\n    "enabled": true,\n    "scope": "job"\n  },\n  "extract": [\n    { "name": "title", "type": "regex", "pattern": "<title>([^<]+)</title>" },\n    { "name": "surface", "type": "surface" }\n  ],\n  "plugins": [\n    { "name": "dedupe" },\n    { "name": "audit" }\n  ]\n}</textarea>
          <button type="submit">Register Workflow</button>
        </form>
        <div id="workflowFormStatus" class="meta" style="margin-top:10px;"></div>
      </section>

      <section class="panel">
        <h2>Reverse Lab</h2>
        <form id="reverseForm">
          <input name="reverseMode" id="reverseMode" placeholder="script or html" value="script" />
          <textarea name="reverseInput" id="reverseInput">function sign(data){ return data + "-sig"; }\nexports.sign = sign;</textarea>
          <button type="submit">Analyze</button>
        </form>
        <div id="reverseOutput" class="list" style="margin-top:12px;"></div>
      </section>

      <section class="panel">
        <h2>Workflows</h2>
        <div id="workflows" class="list"></div>
      </section>

      <section class="panel">
        <h2>Create Interval Schedule</h2>
        <form id="scheduleForm">
          <input name="workflowId" placeholder="Registered workflow id" required />
          <input name="intervalMs" type="number" min="100" step="100" value="60000" required />
          <button type="submit">Create Schedule</button>
        </form>
        <div id="scheduleFormStatus" class="meta" style="margin-top:10px;"></div>
      </section>

      <section class="panel">
        <h2>Schedules</h2>
        <div id="schedules" class="list"></div>
      </section>

      <section class="panel">
        <h2>Recent Jobs</h2>
        <div id="jobs" class="list"></div>
      </section>

      <section class="panel">
        <h2>Job Inspector</h2>
        <form id="inspectForm">
          <input name="jobId" id="inspectJobId" placeholder="Job id" />
          <input name="query" id="inspectQuery" placeholder="Search results/events" />
          <button type="submit">Inspect Job</button>
        </form>
        <div id="jobDetail" class="list" style="margin-top:12px;"></div>
      </section>

      <section class="panel">
        <h2>Job Compare</h2>
        <form id="compareForm">
          <input name="leftJobId" id="compareLeftJobId" placeholder="Left job id" />
          <input name="rightJobId" id="compareRightJobId" placeholder="Right job id" />
          <button type="submit">Compare</button>
        </form>
        <div id="jobCompare" class="list" style="margin-top:12px;"></div>
      </section>

      <section class="panel">
        <h2>Browser Pool</h2>
        <div id="browserPool" class="list"></div>
      </section>

      <section class="panel">
        <h2>Proxy Runtime</h2>
        <div id="proxyPool" class="list"></div>
      </section>

      <section class="panel">
        <h2>Sessions</h2>
        <div id="sessions" class="list"></div>
      </section>

      <section class="panel">
        <h2>App Capture</h2>
        <div id="appCaptureSessions" class="list"></div>
      </section>
    </main>
    <script>
      let selectedJobId = '';
      let selectedResultOffset = 0;
      let selectedEventOffset = 0;
      const QUICK_TEMPLATES = {
        static: {
          taskName: 'quick-static',
          sourceType: 'static-page',
          extractPreset: 'title-links',
          maxDepth: 1,
          maxPages: 20,
          renderWaitMs: 0
        },
        browser: {
          taskName: 'quick-browser',
          sourceType: 'browser-rendered',
          extractPreset: 'article',
          maxDepth: 0,
          maxPages: 10,
          renderWaitMs: 1200
        },
        api: {
          taskName: 'quick-api',
          sourceType: 'api-json',
          extractPreset: 'json-payload',
          maxDepth: 0,
          maxPages: 5,
          renderWaitMs: 0
        },
        sitemap: {
          taskName: 'quick-sitemap',
          sourceType: 'sitemap',
          extractPreset: 'title-links',
          maxDepth: 0,
          maxPages: 50,
          renderWaitMs: 0
        }
      };

      async function getJson(url, options) {
        const response = await fetch(url, options);
        if (!response.ok) {
          let message = response.statusText;
          try {
            const payload = await response.json();
            message = payload.error || message;
          } catch {}
          throw new Error(message);
        }
        return response.json();
      }

      function renderList(targetId, items, mapItem) {
        const root = document.getElementById(targetId);
        if (!items.length) {
          root.innerHTML = '<div class="meta">No items yet.</div>';
          return;
        }
        root.innerHTML = items.map(mapItem).join('');
      }

      function totalAlerts(item) {
        return (item?.quality?.alerts?.length || 0) + (item?.baseline?.alerts?.length || 0) + (item?.trend?.alerts?.length || 0);
      }

      function slugifyWorkflowId(value) {
        return String(value || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64);
      }

      function positiveInt(value, fallback, minValue, maxValue) {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
          return fallback;
        }
        return Math.max(minValue, Math.min(maxValue, Math.round(parsed)));
      }

      function buildQuickTemplatePayload() {
        const form = document.getElementById('quickStartForm');
        const formData = new FormData(form);
        const seedUrl = String(formData.get('seedUrl') || '').trim();
        if (!seedUrl) {
          throw new Error('目标网址不能为空');
        }

        return {
          taskName: String(formData.get('taskName') || 'quick-start').trim() || 'quick-start',
          seedUrl,
          sourceType: String(formData.get('sourceType') || 'static-page'),
          extractPreset: String(formData.get('extractPreset') || 'title-links'),
          maxDepth: positiveInt(formData.get('maxDepth'), 0, 0, 3),
          maxPages: positiveInt(formData.get('maxPages'), 20, 1, 200),
          renderWaitMs: positiveInt(formData.get('renderWaitMs'), 800, 0, 10000),
          workflowId: String(formData.get('workflowId') || '').trim(),
          useSession: document.getElementById('quickUseSession').checked,
          useBrowserDebug: document.getElementById('quickUseBrowserDebug').checked,
          persistBodies: document.getElementById('quickPersistBodies').checked
        };
      }

      async function requestQuickWorkflowBuild() {
        return getJson('/tools/workflow-templates/build', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildQuickTemplatePayload())
        });
      }

      async function updateQuickPreview() {
        const preview = document.getElementById('quickWorkflowPreview');
        try {
          const payload = await requestQuickWorkflowBuild();
          preview.innerHTML = '<pre style="white-space:pre-wrap;font-size:12px;">' +
            escapeHtml(JSON.stringify(payload.item.workflow, null, 2)) +
            '</pre>';
        } catch (error) {
          preview.innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>';
        }
      }

      function applyQuickTemplate(name) {
        const template = QUICK_TEMPLATES[name];
        if (!template) {
          return;
        }

        const form = document.getElementById('quickStartForm');
        for (const [key, value] of Object.entries(template)) {
          const field = form.elements.namedItem(key);
          if (field) {
            field.value = String(value);
          }
        }
        void updateQuickPreview();
      }

      async function runQuickWorkflow() {
        const status = document.getElementById('quickStartStatus');
        status.textContent = '正在启动任务...';
        try {
          const payload = await requestQuickWorkflowBuild();
          const workflow = payload.item.workflow;
          const response = await getJson('/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow })
          });
          status.textContent = '任务已启动：' + response.jobId;
          await refresh();
          if (response.jobId) {
            await inspectJob(response.jobId);
          }
        } catch (error) {
          status.textContent = error.message;
        }
      }

      async function registerQuickWorkflow() {
        const status = document.getElementById('quickStartStatus');
        status.textContent = '正在注册工作流...';
        try {
          const payload = await requestQuickWorkflowBuild();
          const workflow = payload.item.workflow;
          const workflowId = payload.item.suggestedWorkflowId || slugifyWorkflowId(workflow.name);
          await getJson('/workflows', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workflow,
              id: workflowId || undefined,
              description: 'Generated from zero-code quick start'
            })
          });
          status.textContent = '工作流已注册：' + workflowId;
          await refresh();
        } catch (error) {
          status.textContent = error.message;
        }
      }

      async function fillAdvancedEditor() {
        const payload = await requestQuickWorkflowBuild();
        const workflow = payload.item.workflow;
        document.querySelector('#workflowForm [name="workflowJson"]').value = JSON.stringify(workflow, null, 2);
        document.querySelector('#workflowForm [name="workflowId"]').value =
          payload.item.suggestedWorkflowId || slugifyWorkflowId(workflow.name);
        document.getElementById('quickStartStatus').textContent = '已写入高级编辑器，可继续微调后注册。';
      }

      function buildExtractPreviewPayload() {
        const form = document.getElementById('extractPreviewForm');
        const formData = new FormData(form);
        const ruleType = String(formData.get('ruleType') || 'selector');
        const ruleName = String(formData.get('ruleName') || 'preview').trim() || 'preview';
        const query = String(formData.get('ruleQuery') || '').trim();
        const attribute = String(formData.get('attribute') || '').trim();
        const all = document.getElementById('extractPreviewAll').checked;

        const rule = { name: ruleName, type: ruleType };
        if (ruleType === 'selector') {
          rule.selector = query;
          if (attribute) {
            rule.attribute = attribute;
          }
          rule.all = all;
        } else if (ruleType === 'xpath') {
          rule.xpath = query;
          rule.all = all;
          rule.xml = false;
        } else if (ruleType === 'json') {
          rule.path = query;
        } else if (ruleType === 'regex') {
          rule.pattern = query;
          rule.all = all;
        }

        return {
          url: String(formData.get('url') || '').trim(),
          sourceType: String(formData.get('sourceType') || 'static-page'),
          renderWaitMs: positiveInt(formData.get('renderWaitMs'), 800, 0, 10000),
          rule,
        };
      }

      async function previewExtraction() {
        const status = document.getElementById('extractPreviewStatus');
        const output = document.getElementById('extractPreviewOutput');
        status.textContent = '正在预览提取结果...';
        output.innerHTML = '';
        try {
          const payload = buildExtractPreviewPayload();
          const response = await getJson('/tools/extract-preview', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload)
          });
          status.textContent = '预览完成。';
          output.innerHTML =
            '<div class="card"><strong>提取值</strong><pre style="white-space:pre-wrap;font-size:12px;">' +
            escapeHtml(JSON.stringify(response.item.extracted, null, 2)) +
            '</pre></div>' +
            '<div class="card"><strong>Result Meta</strong><pre style="white-space:pre-wrap;font-size:12px;">' +
            escapeHtml(JSON.stringify({
              status: response.item.result?.status ?? null,
              finalUrl: response.item.result?.finalUrl ?? null,
              summaryStatus: response.item.summary?.status ?? null,
            }, null, 2)) +
            '</pre></div>' +
            '<div class="card"><strong>完整 extracted</strong><pre style="white-space:pre-wrap;font-size:12px;">' +
            escapeHtml(JSON.stringify(response.item.result?.extracted ?? null, null, 2)) +
            '</pre></div>';
        } catch (error) {
          status.textContent = error.message;
          output.innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>';
        }
      }

      function openFieldPicker() {
        const form = document.getElementById('fieldPickerForm');
        const formData = new FormData(form);
        const url = String(formData.get('url') || '').trim();
        if (!url) {
          document.getElementById('fieldPickerStatus').textContent = '目标网址不能为空';
          return;
        }
        const pickerUrl =
          '/tools/field-picker/document?url=' + encodeURIComponent(url) +
          '&sourceType=' + encodeURIComponent(String(formData.get('sourceType') || 'static-page')) +
          '&renderWaitMs=' + encodeURIComponent(String(formData.get('renderWaitMs') || '800'));
        window.open(pickerUrl, 'omnicrawl-field-picker', 'width=1280,height=900');
        document.getElementById('fieldPickerStatus').textContent = '字段点选器已打开，点击元素后会回填候选规则。';
      }

      async function refresh() {
        const [health, workflows, schedules, jobs, browserPool, proxyPool, sessions, appCaptureSessions] = await Promise.all([
          getJson('/health'),
          getJson('/workflows'),
          getJson('/schedules'),
          getJson('/history'),
          getJson('/runtime/browser-pool'),
          getJson('/runtime/proxies'),
          getJson('/sessions'),
          getJson('/tools/app-capture/sessions').catch(() => ({ items: [] }))
        ]);

        document.getElementById('health').innerHTML =
          '<span class="' + (health.status === 'ok' ? 'status-ok' : 'status-bad') + '">' + health.status + '</span>' +
          ' · ' + health.name + ' v' + health.version;

        document.getElementById('capabilities').innerHTML = health.extractors
          .concat(health.plugins)
          .map((item) => '<span class="pill">' + item + '</span>')
          .join('');

        document.getElementById('historyHealth').innerHTML =
          '<div class="card">' +
            '<strong>Recent Run Health</strong><br />' +
            '<span class="meta">avg health: ' + (health.history?.averageHealthScore == null ? 'n/a' : Math.round(health.history.averageHealthScore)) + '</span><br />' +
            '<span class="meta">warning runs: ' + (health.history?.warningRuns || 0) + ' · delivered alerts: ' + (health.history?.deliveredAlerts || 0) + '</span><br />' +
            '<span class="meta">last delivery: ' + (health.history?.latestDeliveredAt || 'none') + '</span>' +
          '</div>';

        renderList('workflows', workflows.items, (item) => (
          '<div class="card">' +
            '<strong>' + item.name + '</strong><br />' +
            '<span class="meta"><code>' + item.id + '</code></span><br />' +
            '<div class="toolbar" style="margin-top:10px;">' +
              '<button type="button" onclick="runWorkflow(\\'' + item.id + '\\')">Run</button>' +
            '</div>' +
          '</div>'
        ));

        renderList('schedules', schedules.items, (item) => (
          '<div class="card">' +
            '<strong><code>' + item.id + '</code></strong><br />' +
            '<span class="meta">workflow: <code>' + item.workflowId + '</code> · interval: ' + item.intervalMs + 'ms</span><br />' +
            '<span class="meta">enabled: ' + item.enabled + ' · last job: ' + (item.lastJobId || 'none') + '</span><br />' +
            '<div class="toolbar" style="margin-top:10px;">' +
              '<button class="secondary" type="button" onclick="toggleSchedule(\\'' + item.id + '\\',' + (!item.enabled) + ')">' + (item.enabled ? 'Disable' : 'Enable') + '</button>' +
            '</div>' +
          '</div>'
        ));

        renderList('jobs', jobs.items, (item) => (
          '<div class="card">' +
            '<strong>' + item.workflowName + '</strong><br />' +
            '<span class="meta"><code>' + item.jobId + '</code> · ' + item.status + '</span><br />' +
            '<span class="meta">pages: ' + item.pagesFetched + ' · results: ' + item.resultCount + ' · failures: ' + item.failureCount + '</span><br />' +
            '<span class="meta">health: ' + (item.quality?.healthScore == null ? 'n/a' : item.quality.healthScore) + ' · alerts: ' + totalAlerts(item) + ' · webhook: ' + (item.alertDelivery?.delivered ? 'delivered' : (item.alertDelivery?.attempted ? 'failed' : 'none')) + '</span><br />' +
            '<span class="meta">trigger: ' + (item.metadata?.trigger || 'manual') + ' · session: ' + (item.metadata?.sessionId || item.sessionId || 'none') + '</span><br />' +
            '<div class="toolbar" style="margin-top:10px;">' +
              '<button type="button" onclick="inspectJob(\\'' + item.jobId + '\\')">Inspect</button>' +
              '<button class="secondary" type="button" onclick="replayJob(\\'' + item.jobId + '\\')">Replay</button>' +
            '</div>' +
          '</div>'
        ));

        renderList('browserPool', browserPool.items, (item) => (
          '<div class="card">' +
            '<strong><code>' + (item.proxyServer || 'direct') + '</code></strong><br />' +
            '<span class="meta">contexts: ' + item.contextCount + ' · active pages: ' + item.activePages + '</span><br />' +
            '<span class="meta">headless: ' + item.headless + ' · last used: ' + item.lastUsedAt + '</span>' +
          '</div>'
        ));

        renderList('proxyPool', proxyPool.items, (item) => (
          '<div class="card">' +
            '<strong><code>' + item.label + '</code></strong><br />' +
            '<span class="meta">' + item.server + '</span><br />' +
            '<span class="meta">score: ' + item.score + ' · success: ' + item.successCount + ' · failure: ' + item.failureCount + '</span><br />' +
            '<span class="meta">cooldown: ' + item.inCooldown + ' · selected: ' + item.selectedCount + ' · disabled: ' + item.effectiveDisabled + '</span><br />' +
            '<span class="meta">probe: ' + (item.lastProbeOk === null ? 'never' : item.lastProbeOk) + ' · probe status: ' + (item.lastProbeStatus || 'n/a') + '</span><br />' +
            '<span class="meta">notes: ' + escapeHtml(item.notes || '') + '</span>' +
            '<div class="toolbar" style="margin-top:10px;">' +
              '<button class="secondary" type="button" onclick="toggleProxy(\\'' + escapeJs(item.key) + '\\',' + item.effectiveDisabled + ')">' + (item.effectiveDisabled ? 'Enable' : 'Disable') + '</button>' +
              '<button class="secondary" type="button" onclick="probeProxy(\\'' + escapeJs(item.key) + '\\')">Probe</button>' +
              '<button class="secondary" type="button" onclick="editProxyNote(\\'' + escapeJs(item.key) + '\\',\\'' + escapeJs(item.notes || '') + '\\')">Note</button>' +
              '<button class="secondary" type="button" onclick="resetProxy(\\'' + escapeJs(item.key) + '\\')">Reset</button>' +
            '</div>' +
          '</div>'
        ));

        renderList('sessions', sessions.items, (item) => (
          '<div class="card">' +
            '<strong><code>' + item.id + '</code></strong><br />' +
            '<span class="meta">cookies: ' + item.cookieCount + ' · origins: ' + item.originCount + '</span><br />' +
            '<span class="meta">last url: ' + (item.lastUrl || 'none') + '</span>' +
          '</div>'
        ));

        renderList('appCaptureSessions', appCaptureSessions.items || [], (item) => (
          '<div class="card">' +
            '<strong><code>' + escapeHtml(item.id || '') + '</code></strong><br />' +
            '<span class="meta">status: ' + escapeHtml(item.status || 'unknown') + '</span><br />' +
            '<span class="meta">asset: ' + escapeHtml(item.assetRef?.assetId || 'none') + '</span><br />' +
            '<span class="meta">generated files: ' + escapeHtml(String(Object.keys(item.generated || {}).length)) + '</span>' +
            '<div class="toolbar" style="margin-top:10px;">' +
              '<button class="secondary" type="button" onclick="inspectAppCaptureAsset(\\'' + escapeJs(item.id || '') + '\\',\\'appCaptureAssetDetail-' + escapeJs(item.id || '') + '\\')">Load Asset</button>' +
            '</div>' +
            '<div id="appCaptureAssetDetail-' + escapeJs(item.id || '') + '"></div>' +
          '</div>'
        ));

        if (selectedJobId) {
          await inspectJob(selectedJobId, { silent: true });
        }
      }

      async function runWorkflow(workflowId) {
        await getJson('/workflows/' + workflowId + '/run', { method: 'POST' });
        await refresh();
      }

      async function replayJob(jobId) {
        await getJson('/history/' + jobId + '/replay', { method: 'POST' });
        await refresh();
      }

      async function runReverseAnalysis() {
        const mode = document.getElementById('reverseMode').value.trim() || 'script';
        const input = document.getElementById('reverseInput').value;
        const payload = mode === 'html'
          ? { mode, html: input, baseUrl: 'https://example.com' }
          : { mode, code: input, target: 'inline://reverse-lab.js' };

        const response = await getJson('/reverse/analyze', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });

        document.getElementById('reverseOutput').innerHTML =
          '<div class="card"><pre style="white-space:pre-wrap;font-size:12px;">' +
          escapeHtml(JSON.stringify(response.result, null, 2)) +
          '</pre></div>';
      }

      async function exportJob(jobId, kind, format) {
        const query = document.getElementById('inspectQuery').value.trim();
        const response = await fetch('/jobs/' + jobId + '/export?kind=' + encodeURIComponent(kind) + '&format=' + encodeURIComponent(format) + '&query=' + encodeURIComponent(query));
        const text = await response.text();
        const blob = new Blob([text], { type: response.headers.get('content-type') || 'text/plain' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = jobId + '-' + kind + '.' + (format === 'json' ? 'json' : format);
        anchor.click();
        URL.revokeObjectURL(url);
      }

      async function inspectReverseAsset(jobId, collection, assetId, containerId) {
        const container = document.getElementById(containerId);
        if (!container) {
          return;
        }

        container.innerHTML = '<div class="meta">Loading reverse asset...</div>';
        try {
          const detail = await getJson(
            '/jobs/' + encodeURIComponent(jobId) +
            '/reverse-assets/item?collection=' + encodeURIComponent(collection) +
            '&assetId=' + encodeURIComponent(assetId)
          );
          container.innerHTML =
            '<div class="card">' +
              '<strong>Asset Detail</strong><br />' +
              '<span class="meta"><code>' + escapeHtml(assetId) + '</code></span><br />' +
              '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify(detail.item, null, 2)) + '</pre>' +
            '</div>';
        } catch (error) {
          container.innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>';
        }
      }

      async function inspectAppCaptureAsset(sessionId, containerId) {
        const container = document.getElementById(containerId);
        if (!container) {
          return;
        }

        container.innerHTML = '<div class="meta">Loading app capture asset...</div>';
        try {
          const detail = await getJson('/tools/app-capture/sessions/' + encodeURIComponent(sessionId) + '/asset');
          container.innerHTML =
            '<div class="card">' +
              '<strong>App Capture Asset</strong><br />' +
              '<span class="meta"><code>' + escapeHtml(detail.assetRef?.assetId || '') + '</code></span><br />' +
              '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify(detail.item, null, 2)) + '</pre>' +
            '</div>';
        } catch (error) {
          container.innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>';
        }
      }

      async function toggleProxy(key, currentlyDisabled) {
        await getJson('/runtime/proxies/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            key,
            enabled: currentlyDisabled
          })
        });
        await refresh();
      }

      async function resetProxy(key) {
        await getJson('/runtime/proxies/reset', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key })
        });
        await refresh();
      }

      async function probeProxy(key) {
        const targetUrl = prompt('Probe target URL', 'http://example.com');
        if (!targetUrl) {
          return;
        }
        await getJson('/runtime/proxies/probe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, targetUrl })
        });
        await refresh();
      }

      async function editProxyNote(key, currentNote) {
        const notes = prompt('Proxy notes', currentNote || '');
        if (notes === null) {
          return;
        }
        await getJson('/runtime/proxies/control', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key, notes })
        });
        await refresh();
      }

      async function inspectJob(jobId, options = {}) {
        selectedJobId = jobId;
        if (!options.keepOffsets) {
          selectedResultOffset = 0;
          selectedEventOffset = 0;
        }
        document.getElementById('inspectJobId').value = jobId;
        const query = document.getElementById('inspectQuery').value.trim();
        try {
          const detailUrl =
            '/jobs/' + jobId + '/detail?query=' + encodeURIComponent(query) +
            '&offsetResults=' + selectedResultOffset +
            '&offsetEvents=' + selectedEventOffset +
            '&limitResults=10&limitEvents=10';
          const [detail, diagnosticsPayload, recipePayload, failedPayload] = await Promise.all([
            getJson(detailUrl),
            getJson('/jobs/' + jobId + '/diagnostics'),
            getJson('/jobs/' + jobId + '/replay-recipe'),
            getJson('/jobs/' + jobId + '/failed-requests?limit=5&offset=0&query=' + encodeURIComponent(query))
          ]);
          const summary = detail.summary || detail.job || {};
          const diagnostics = diagnosticsPayload.item || {};
          const recipe = recipePayload.item || {};
          const failedItems = failedPayload.items || [];
          const reverseAssets = detail.reverseAssets || {};
          const aiSurfaceRefs = reverseAssets.aiSurfaces || [];
          const latestAiSurface = detail.latestAiSurface?.payload || null;
          const latestAiSurfaceRef = aiSurfaceRefs[0] || null;
          const resultCards = (detail.results || []).map((item) => (
            '<div class="card">' +
              '<strong><code>' + item.finalUrl + '</code></strong><br />' +
              '<span class="meta">status: ' + item.status + ' · mode: ' + item.mode + ' · depth: ' + item.depth + '</span><br />' +
              '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify(item.extracted, null, 2)) + '</pre>' +
            '</div>'
          )).join('');
          const eventCards = (detail.events || []).map((item) => (
            '<div class="card">' +
              '<strong>' + item.type + '</strong><br />' +
              '<span class="meta">' + item.at + '</span><br />' +
              '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify(item, null, 2)) + '</pre>' +
            '</div>'
          )).join('');
          const suspectCards = (diagnostics.suspects || []).slice(0, 5).map((item) => (
            '<div class="card">' +
              '<strong>' + escapeHtml(item.type || 'unknown') + '</strong><br />' +
              '<span class="meta">score: ' + escapeHtml(String(item.score || 0)) + '</span><br />' +
              '<span class="meta">' + escapeHtml(item.reason || '') + '</span>' +
            '</div>'
          )).join('');
          const recoveryCards = (diagnostics.recovery || []).slice(0, 4).map((item) => (
            '<div class="card">' +
              '<strong>' + escapeHtml(item.type || 'recovery') + '</strong><br />' +
              '<span class="meta">' + escapeHtml(item.reason || '') + '</span><br />' +
              '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify(item.actions || [], null, 2)) + '</pre>' +
            '</div>'
          )).join('');
          const failedCards = failedItems.map((item) => (
            '<div class="card">' +
              '<strong><code>' + escapeHtml(item.url || 'unknown') + '</code></strong><br />' +
              '<span class="meta">status: ' + escapeHtml(String(item.status || 'n/a')) + ' · attempt: ' + escapeHtml(String(item.attempt || 0)) + '</span><br />' +
              '<span class="meta">' + escapeHtml(item.error || '') + '</span>' +
            '</div>'
          )).join('');

          document.getElementById('jobDetail').innerHTML =
            '<div class="card">' +
              '<strong><code>' + jobId + '</code></strong><br />' +
              '<span class="meta">status: ' + (detail.job?.status || summary.status || 'unknown') + '</span><br />' +
              '<span class="meta">pages: ' + (summary.pagesFetched ?? detail.job?.stats?.pagesFetched ?? 0) + ' · results: ' + (summary.resultCount ?? detail.job?.stats?.resultCount ?? 0) + '</span><br />' +
              '<span class="meta">health: ' + (summary.quality?.healthScore == null ? 'n/a' : summary.quality.healthScore) + ' · quality alerts: ' + (summary.quality?.alerts?.length || 0) + ' · baseline alerts: ' + (summary.baseline?.alerts?.length || 0) + ' · trend alerts: ' + (summary.trend?.alerts?.length || 0) + '</span><br />' +
              '<span class="meta">baseline prev: ' + (summary.baseline?.previousJobId || 'none') + ' · trend samples: ' + (summary.trend?.sampleCount || 0) + '</span><br />' +
              '<span class="meta">webhook: ' + (summary.alertDelivery?.delivered ? 'delivered' : (summary.alertDelivery?.attempted ? 'failed' : 'none')) + ' · attempts: ' + (summary.alertDelivery?.attempts || 0) + '</span>' +
            '</div>' +
            '<div class="card">' +
              '<strong>Reverse Assets</strong><br />' +
              '<span class="meta">signers: ' + escapeHtml(String((reverseAssets.signers || []).length)) +
              ' · regressions: ' + escapeHtml(String((reverseAssets.regressions || []).length)) +
              ' · app captures: ' + escapeHtml(String((reverseAssets.appCaptures || []).length)) +
              ' · ai surfaces: ' + escapeHtml(String(aiSurfaceRefs.length)) + '</span><br />' +
              '<span class="meta">latest ai target: ' + escapeHtml(latestAiSurface?.target || 'none') + '</span><br />' +
              '<span class="meta">latest ai classification: ' + escapeHtml(latestAiSurface?.protection?.classification || 'none') + '</span><br />' +
              '<span class="meta">latest ai endpoints: ' + escapeHtml(String((latestAiSurface?.apiParameters?.endpoints || []).slice(0, 3).join(', ') || 'none')) + '</span>' +
              (latestAiSurface
                ? (
                  '<details style="margin-top:10px;">' +
                    '<summary>Latest AI Summary JSON</summary>' +
                    '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify(latestAiSurface, null, 2)) + '</pre>' +
                  '</details>'
                )
                : '<div class="meta" style="margin-top:10px;">No AI summary stored.</div>') +
              (latestAiSurfaceRef
                ? (
                  '<div class="toolbar" style="margin-top:10px;">' +
                    '<button class="secondary" type="button" onclick="inspectReverseAsset(\\'' + escapeJs(jobId) + '\\',\\'aiSurfaces\\',\\'' + escapeJs(latestAiSurfaceRef.assetId) + '\\',\\'jobReverseAssetDetail\\')">Load Asset Detail</button>' +
                  '</div>'
                )
                : '') +
              '<div id="jobReverseAssetDetail"></div>' +
            '</div>' +
            '<div class="card">' +
              '<strong>简明诊断</strong><br />' +
              '<span class="meta">recommended replay: ' + escapeHtml(recipe.recommendedMode || 'http') + '</span><br />' +
              '<span class="meta">signals: challenge ' + escapeHtml(String(diagnostics.signals?.challengeCount || 0)) +
              ' · signature ' + escapeHtml(String(diagnostics.signals?.signatureLikelyCount || 0)) +
              ' · auth ' + escapeHtml(String(diagnostics.signals?.authWallCount || 0)) + '</span><br />' +
              '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify((recipe.rationale || []).slice(0, 4), null, 2)) + '</pre>' +
            '</div>' +
            '<div class="card"><strong>Top Suspects</strong></div>' +
            (suspectCards || '<div class="meta">No diagnostics suspects.</div>') +
            '<div class="card"><strong>Recovery Suggestions</strong></div>' +
            (recoveryCards || '<div class="meta">No recovery suggestions.</div>') +
            '<div class="card"><strong>Failed Requests</strong></div>' +
            (failedCards || '<div class="meta">No failed requests.</div>') +
            '<div class="card"><strong>Results</strong><div class="toolbar" style="margin-top:10px;">' +
              '<button class="secondary" type="button" onclick="pageResults(-10)">Prev</button>' +
              '<button class="secondary" type="button" onclick="pageResults(10)">Next</button>' +
              '<button class="secondary" type="button" onclick="exportJob(\\'' + jobId + '\\',\\'results\\',\\'json\\')">Export JSON</button>' +
              '<button class="secondary" type="button" onclick="exportJob(\\'' + jobId + '\\',\\'results\\',\\'csv\\')">Export CSV</button>' +
              '<span class="meta">offset ' + detail.resultPage.offset + ' / total ' + detail.resultPage.total + '</span>' +
            '</div></div>' +
            (resultCards || '<div class="meta">No results.</div>') +
            '<div class="card"><strong>Events</strong><div class="toolbar" style="margin-top:10px;">' +
              '<button class="secondary" type="button" onclick="pageEvents(-10)">Prev</button>' +
              '<button class="secondary" type="button" onclick="pageEvents(10)">Next</button>' +
              '<button class="secondary" type="button" onclick="exportJob(\\'' + jobId + '\\',\\'events\\',\\'ndjson\\')">Export NDJSON</button>' +
              '<span class="meta">offset ' + detail.eventPage.offset + ' / total ' + detail.eventPage.total + '</span>' +
            '</div></div>' +
            (eventCards || '<div class="meta">No events.</div>');
        } catch (error) {
          if (!options.silent) {
            document.getElementById('jobDetail').innerHTML = '<div class="meta">' + escapeHtml(error.message) + '</div>';
          }
        }
      }

      function pageResults(delta) {
        selectedResultOffset = Math.max(0, selectedResultOffset + delta);
        if (selectedJobId) {
          inspectJob(selectedJobId, { silent: true, keepOffsets: true }).catch(() => {});
        }
      }

      function pageEvents(delta) {
        selectedEventOffset = Math.max(0, selectedEventOffset + delta);
        if (selectedJobId) {
          inspectJob(selectedJobId, { silent: true, keepOffsets: true }).catch(() => {});
        }
      }

      async function compareJobs(leftJobId, rightJobId) {
        const detail = await getJson('/jobs/compare?left=' + encodeURIComponent(leftJobId) + '&right=' + encodeURIComponent(rightJobId));
        document.getElementById('jobCompare').innerHTML =
          '<div class="card">' +
            '<strong>Left</strong><br />' +
            '<span class="meta"><code>' + detail.left.jobId + '</code> · ' + detail.left.workflowName + ' · ' + detail.left.status + '</span><br />' +
            '<span class="meta">pages: ' + detail.left.pagesFetched + ' · results: ' + detail.left.resultCount + ' · failures: ' + detail.left.failureCount + '</span>' +
          '</div>' +
          '<div class="card">' +
            '<strong>Right</strong><br />' +
            '<span class="meta"><code>' + detail.right.jobId + '</code> · ' + detail.right.workflowName + ' · ' + detail.right.status + '</span><br />' +
            '<span class="meta">pages: ' + detail.right.pagesFetched + ' · results: ' + detail.right.resultCount + ' · failures: ' + detail.right.failureCount + '</span>' +
          '</div>' +
          '<div class="card">' +
            '<strong>Overlap</strong><br />' +
            '<span class="meta">shared: ' + detail.overlap.sharedCount + ' · left only: ' + detail.overlap.leftOnlyCount + ' · right only: ' + detail.overlap.rightOnlyCount + '</span><br />' +
            '<pre style="white-space:pre-wrap;font-size:12px;">' + escapeHtml(JSON.stringify(detail.overlap, null, 2)) + '</pre>' +
          '</div>';
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
      }

      function escapeJs(value) {
        return String(value).replaceAll('\\\\', '\\\\\\\\').replaceAll('\\'', '\\\\\'');
      }

      async function toggleSchedule(scheduleId, enabled) {
        await getJson('/schedules/' + scheduleId, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        await refresh();
      }

      document.getElementById('refreshButton').addEventListener('click', refresh);

      document.getElementById('workflowForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const status = document.getElementById('workflowFormStatus');
        status.textContent = 'Registering...';
        try {
          const workflow = JSON.parse(String(form.get('workflowJson') || '{}'));
          const workflowId = String(form.get('workflowId') || '').trim();
          await getJson('/workflows', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workflow, id: workflowId || undefined })
          });
          status.textContent = 'Workflow registered.';
          await refresh();
        } catch (error) {
          status.textContent = error.message;
        }
      });

      document.getElementById('reverseForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        await runReverseAnalysis();
      });

      document.getElementById('inspectForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const jobId = document.getElementById('inspectJobId').value.trim();
        if (!jobId) {
          return;
        }
        await inspectJob(jobId);
      });

      document.getElementById('compareForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const leftJobId = document.getElementById('compareLeftJobId').value.trim();
        const rightJobId = document.getElementById('compareRightJobId').value.trim();
        if (!leftJobId || !rightJobId) {
          return;
        }
        await compareJobs(leftJobId, rightJobId);
      });

      document.getElementById('scheduleForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.target);
        const status = document.getElementById('scheduleFormStatus');
        status.textContent = 'Creating schedule...';
        try {
          await getJson('/schedules', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workflowId: String(form.get('workflowId')),
              intervalMs: Number(form.get('intervalMs')),
              enabled: true
            })
          });
          status.textContent = 'Schedule created.';
          await refresh();
        } catch (error) {
          status.textContent = error.message;
        }
      });

      document.getElementById('quickRunButton').addEventListener('click', runQuickWorkflow);
      document.getElementById('quickRegisterButton').addEventListener('click', registerQuickWorkflow);
      document.getElementById('quickFillEditorButton').addEventListener('click', fillAdvancedEditor);
      document.getElementById('quickStartForm').addEventListener('input', () => { void updateQuickPreview(); });
      document.getElementById('openFieldPickerButton').addEventListener('click', openFieldPicker);
      document.getElementById('extractPreviewForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        await previewExtraction();
      });
      window.addEventListener('message', (event) => {
        const payload = event.data;
        if (!payload || payload.channel !== 'omnicrawl-field-picker') {
          return;
        }
        const detail = payload.detail || {};
        const output = document.getElementById('fieldPickerOutput');
        document.getElementById('fieldPickerStatus').textContent = '已接收字段候选，可直接预览提取结果。';
        document.querySelector('#extractPreviewForm [name="url"]').value = detail.targetUrl || document.querySelector('#fieldPickerForm [name="url"]').value;
        document.querySelector('#extractPreviewForm [name="sourceType"]').value = detail.sourceType || 'static-page';
        document.querySelector('#extractPreviewForm [name="ruleType"]').value = 'selector';
        document.querySelector('#extractPreviewForm [name="ruleName"]').value = detail.tag || 'preview';
        document.querySelector('#extractPreviewForm [name="ruleQuery"]').value = detail.selector || '';
        output.innerHTML = '<pre style="white-space:pre-wrap;font-size:12px;">' +
          escapeHtml(JSON.stringify(detail, null, 2)) +
          '</pre>';
      });

      applyQuickTemplate('static');
      refresh().catch((error) => {
        document.getElementById('health').textContent = error.message;
      });
      setInterval(() => { refresh().catch(() => {}); }, 5000);
    </script>
  </body>
</html>`;
}
