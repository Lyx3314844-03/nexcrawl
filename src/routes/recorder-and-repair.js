/**
 * API Routes for Login Recorder and Repair Plan Quick Actions
 */

import { renderLoginRecorderDashboard } from '../runtime/login-recorder-dashboard.js';
import { buildWorkflowRepairPlan, registerAndRerunRepair } from '../runtime/workflow-repair.js';
import { buildAuthStatePlan, extractAuthArtifacts } from '../runtime/auth-state.js';
import { buildReplayWorkflowFromRecording } from '../runtime/replay-workflow.js';

// In-memory storage for active recording session
let activeRecording = null;
const savedSessions = [];

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function mergeAuthStatePlans(base = null, next = null) {
  if (!base) return next;
  if (!next) return base;
  return {
    kind: 'auth-state-plan',
    loginWallDetected: base.loginWallDetected || next.loginWallDetected,
    loginWallReasons: unique([...(base.loginWallReasons ?? []), ...(next.loginWallReasons ?? [])]),
    sessionLikelyRequired: base.sessionLikelyRequired || next.sessionLikelyRequired,
    requiredCookies: unique([...(base.requiredCookies ?? []), ...(next.requiredCookies ?? [])]),
    cookieValues: { ...(base.cookieValues ?? {}), ...(next.cookieValues ?? {}) },
    requiredHeaders: { ...(base.requiredHeaders ?? {}), ...(next.requiredHeaders ?? {}) },
    replayState: { ...(base.replayState ?? {}), ...(next.replayState ?? {}) },
    refreshLikely: base.refreshLikely || next.refreshLikely,
    csrfFields: unique([...(base.csrfFields ?? []), ...(next.csrfFields ?? [])]),
  };
}

function mergeAuthArtifacts(base = null, next = null) {
  if (!base) return next;
  if (!next) return base;
  return {
    loginWall: {
      detected: base.loginWall?.detected || next.loginWall?.detected,
      reasons: unique([...(base.loginWall?.reasons ?? []), ...(next.loginWall?.reasons ?? [])]),
    },
    cookieNames: unique([...(base.cookieNames ?? []), ...(next.cookieNames ?? [])]),
    cookieValues: { ...(base.cookieValues ?? {}), ...(next.cookieValues ?? {}) },
    hiddenFields: { ...(base.hiddenFields ?? {}), ...(next.hiddenFields ?? {}) },
    csrfFields: unique([...(base.csrfFields ?? []), ...(next.csrfFields ?? [])]),
    headerTokens: { ...(base.headerTokens ?? {}), ...(next.headerTokens ?? {}) },
    tokenFields: { ...(base.tokenFields ?? {}), ...(next.tokenFields ?? {}) },
    refreshLikely: base.refreshLikely || next.refreshLikely,
  };
}

function buildActionAuthCapture(payload = {}) {
  const hasAuthSurface =
    payload.status !== undefined
    || payload.headers
    || payload.html
    || payload.body
    || payload.extracted;
  if (!hasAuthSurface) {
    return null;
  }

  return {
    authArtifacts: extractAuthArtifacts(payload),
    authStatePlan: buildAuthStatePlan(payload),
  };
}

export function setupLoginRecorderRoutes(app, { jobStore, workflowRegistry, jobRunner } = {}) {
  // Dashboard UI
  app.get('/login-recorder', (req, res) => {
    const html = renderLoginRecorderDashboard({
      sessions: savedSessions,
      activeRecording,
    });
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  });

  // Start recording
  app.post('/api/login-recorder/start', (req, res) => {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: 'url is required' });
    }

    activeRecording = {
      id: `rec-${Date.now()}`,
      url,
      steps: [],
      startedAt: new Date().toISOString(),
      authArtifacts: null,
      authStatePlan: null,
    };

    res.json({ success: true, recording: activeRecording });
  });

  // Stop recording and save
  app.post('/api/login-recorder/stop', (req, res) => {
    if (!activeRecording) {
      return res.status(400).json({ error: 'No active recording' });
    }

    const session = {
      ...activeRecording,
      stoppedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };

    savedSessions.unshift(session);
    activeRecording = null;

    res.json({ success: true, session });
  });

  // Get recording status
  app.get('/api/login-recorder/status', (req, res) => {
    res.json(activeRecording || { active: false });
  });

  // Record action (called by browser extension or CDP)
  app.post('/api/login-recorder/action', (req, res) => {
    if (!activeRecording) {
      return res.status(400).json({ error: 'No active recording' });
    }

    const {
      type,
      selector,
      value,
      url,
      finalUrl,
      html,
      headers,
      status,
      text,
      element,
      waitForNavigation,
      durationMs,
      direction,
      keyPress,
    } = req.body;
    const authCapture = buildActionAuthCapture(req.body);
    const step = {
      type,
      selector,
      value,
      timestamp: new Date().toISOString(),
      ...(url ? { url } : {}),
      ...(finalUrl ? { finalUrl } : {}),
      ...(html ? { html } : {}),
      ...(headers ? { headers } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(text ? { text } : {}),
      ...(element ? { element } : {}),
      ...(waitForNavigation !== undefined ? { waitForNavigation: waitForNavigation === true } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(direction ? { direction } : {}),
      ...(keyPress ? { keyPress } : {}),
    };

    if (authCapture) {
      step.authArtifacts = authCapture.authArtifacts;
      step.authStatePlan = authCapture.authStatePlan;
      activeRecording.authArtifacts = mergeAuthArtifacts(activeRecording.authArtifacts, authCapture.authArtifacts);
      activeRecording.authStatePlan = mergeAuthStatePlans(activeRecording.authStatePlan, authCapture.authStatePlan);
    }

    activeRecording.steps.push(step);

    res.json({ success: true, stepCount: activeRecording.steps.length });
  });

  // Update session name
  app.patch('/api/login-recorder/sessions/:id', (req, res) => {
    const session = savedSessions.find(s => s.id === req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.name = req.body.name || session.name;
    res.json({ success: true, session });
  });

  // Export session
  app.get('/api/login-recorder/sessions/:id/export', (req, res) => {
    const session = savedSessions.find(s => s.id === req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="login-session-${session.id}.json"`);
    res.json(session);
  });

  app.get('/api/login-recorder/sessions/:id/workflow', (req, res) => {
    const session = savedSessions.find((entry) => entry.id === req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const workflow = buildReplayWorkflowFromRecording({ session });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="login-session-${session.id}-workflow.json"`);
    res.json({
      sessionId: session.id,
      workflow,
    });
  });

  app.get('/api/login-recorder/sessions/:id/repair-plan', (req, res) => {
    const session = savedSessions.find((entry) => entry.id === req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const workflow = buildReplayWorkflowFromRecording({ session });
    const repairPlan = buildWorkflowRepairPlan({
      workflow,
      diagnostics: {
        authStatePlan: session.authStatePlan ?? null,
        suspects: session.authStatePlan?.sessionLikelyRequired
          ? [{ type: 'auth-or-session-state' }]
          : [],
      },
      authStatePlan: session.authStatePlan ?? null,
    });

    res.json({
      sessionId: session.id,
      workflow,
      repairPlan,
    });
  });
}

export function setupRepairPlanRoutes(app, { jobStore, workflowRegistry, jobRunner } = {}) {
  // Register and rerun repaired workflow
  app.post('/api/workflows/register-and-run', async (req, res) => {
    try {
      const { workflow, diagnostics, recipe, failedRequests, authStatePlan } = req.body;

      if (!workflow) {
        return res.status(400).json({ error: 'workflow is required' });
      }

      // Build repair plan
      const repairPlan = buildWorkflowRepairPlan({
        workflow,
        diagnostics,
        recipe,
        failedRequests,
        authStatePlan,
      });

      // Register and run
      const result = await registerAndRerunRepair({
        repairPlan,
        jobStore,
        workflowRegistry,
        jobRunner,
      });

      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error.message,
        stack: error.stack,
      });
    }
  });

  // Get repair plan preview (without executing)
  app.post('/api/workflows/repair-plan', (req, res) => {
    try {
      const { workflow, diagnostics, recipe, failedRequests, authStatePlan } = req.body;

      if (!workflow) {
        return res.status(400).json({ error: 'workflow is required' });
      }

      const repairPlan = buildWorkflowRepairPlan({
        workflow,
        diagnostics,
        recipe,
        failedRequests,
        authStatePlan,
      });

      res.json(repairPlan);
    } catch (error) {
      res.status(500).json({
        error: error.message,
        stack: error.stack,
      });
    }
  });
}
