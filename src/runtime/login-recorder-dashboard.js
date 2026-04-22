/**
 * Login Recorder Dashboard — Minimal visual panel for recording login flows
 */

export function renderLoginRecorderDashboard({ sessions = [], activeRecording = null } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Login Recorder | OmniCrawl</title>
  <style>
    :root {
      --bg: #f4efe6;
      --panel: #fffaf2;
      --line: #d5c7b1;
      --text: #201a16;
      --muted: #756454;
      --accent: #a44d2f;
      --ok: #24754a;
      --warn: #d97706;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, serif;
      color: var(--text);
      background: var(--bg);
    }
    header {
      padding: 24px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 32px; }
    .container { max-width: 1200px; margin: 20px auto; padding: 0 20px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .btn {
      padding: 10px 20px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
    }
    .btn-primary { background: var(--accent); color: white; }
    .btn-ok { background: var(--ok); color: white; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; }
    .status-recording { background: #fee; color: #c00; }
    .status-ready { background: #efe; color: var(--ok); }
    .step { padding: 8px; border-left: 3px solid var(--line); margin: 8px 0; }
    .step-active { border-color: var(--accent); background: var(--accent-soft); }
    .meta { color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <h1>🎬 Login Recorder</h1>
    <p class="meta">Record login flows for session replay</p>
  </header>
  
  <div class="container">
    ${activeRecording ? renderActiveRecording(activeRecording) : renderStartPanel()}
    ${renderSessionList(sessions)}
  </div>

  <script>
    async function startRecording() {
      const url = document.getElementById('targetUrl').value;
      if (!url) return alert('Enter target URL');
      
      const res = await fetch('/api/login-recorder/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      
      if (res.ok) location.reload();
      else alert('Failed to start recording');
    }

    async function stopRecording() {
      const res = await fetch('/api/login-recorder/stop', { method: 'POST' });
      if (res.ok) location.reload();
    }

    async function saveSession(sessionId) {
      const name = prompt('Session name:');
      if (!name) return;
      
      const res = await fetch(\`/api/login-recorder/sessions/\${sessionId}\`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      
      if (res.ok) location.reload();
    }

    setInterval(() => {
      if (document.querySelector('.status-recording')) {
        fetch('/api/login-recorder/status')
          .then(r => r.json())
          .then(data => {
            if (data.steps) {
              document.getElementById('stepCount').textContent = data.steps.length;
            }
          });
      }
    }, 2000);
  </script>
</body>
</html>`;
}

function renderStartPanel() {
  return `
    <div class="panel">
      <h2>Start New Recording</h2>
      <p class="meta">Enter target URL and click Start to begin recording login actions</p>
      <div style="margin-top: 16px;">
        <input 
          id="targetUrl" 
          type="url" 
          placeholder="https://example.com/login" 
          style="width: 100%; padding: 10px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 12px;"
        />
        <button class="btn btn-primary" onclick="startRecording()">▶ Start Recording</button>
      </div>
    </div>
  `;
}

function renderActiveRecording(recording) {
  return `
    <div class="panel">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <h2>Recording in Progress</h2>
          <span class="status status-recording">● RECORDING</span>
        </div>
        <button class="btn btn-ok" onclick="stopRecording()">■ Stop & Save</button>
      </div>
      
      <div style="margin-top: 16px;">
        <p class="meta">Target: <strong>${recording.url}</strong></p>
        <p class="meta">Steps captured: <strong id="stepCount">${recording.steps?.length || 0}</strong></p>
        
        <div style="margin-top: 12px;">
          <h3 style="font-size: 16px; margin: 8px 0;">Recorded Actions:</h3>
          ${(recording.steps || []).map((step, i) => `
            <div class="step ${i === recording.steps.length - 1 ? 'step-active' : ''}">
              <strong>${step.type}</strong>
              ${step.selector ? `<span class="meta"> → ${step.selector}</span>` : ''}
              ${step.value ? `<span class="meta"> = "${step.value}"</span>` : ''}
            </div>
          `).join('')}
        </div>
        ${recording.authStatePlan ? `
          <div style="margin-top: 16px;">
            <h3 style="font-size: 16px; margin: 8px 0;">Auth Signals</h3>
            <p class="meta">Login wall: <strong>${recording.authStatePlan.loginWallDetected ? 'yes' : 'no'}</strong></p>
            <p class="meta">Cookies: <strong>${(recording.authStatePlan.requiredCookies || []).join(', ') || 'none'}</strong></p>
            <p class="meta">CSRF fields: <strong>${(recording.authStatePlan.csrfFields || []).join(', ') || 'none'}</strong></p>
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderSessionList(sessions) {
  if (!sessions.length) return '';
  
  return `
    <div class="panel">
      <h2>Saved Sessions</h2>
      <div style="margin-top: 12px;">
        ${sessions.map(session => `
          <div style="padding: 12px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center;">
              <div>
                <strong>${session.name || 'Unnamed Session'}</strong>
                <p class="meta">${session.steps?.length || 0} steps · ${new Date(session.createdAt).toLocaleString()}</p>
                ${session.authStatePlan ? `<p class="meta">Auth hints: cookies=${(session.authStatePlan.requiredCookies || []).length}, csrf=${(session.authStatePlan.csrfFields || []).length}, loginWall=${session.authStatePlan.loginWallDetected ? 'yes' : 'no'}</p>` : ''}
              </div>
              <div>
                <button class="btn" onclick="saveSession('${session.id}')" style="font-size: 12px; padding: 6px 12px;">✏ Rename</button>
                <a href="/api/login-recorder/sessions/${session.id}/export" class="btn" style="font-size: 12px; padding: 6px 12px; text-decoration: none;">⬇ Export</a>
                <a href="/api/login-recorder/sessions/${session.id}/workflow" class="btn" style="font-size: 12px; padding: 6px 12px; text-decoration: none;">⚙ Workflow</a>
                <a href="/api/login-recorder/sessions/${session.id}/repair-plan" class="btn" style="font-size: 12px; padding: 6px 12px; text-decoration: none;">🩹 Repair</a>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}
