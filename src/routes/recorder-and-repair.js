/**
 * API Routes for Login Recorder and Repair Plan Quick Actions
 */

import { renderLoginRecorderDashboard } from '../runtime/login-recorder-dashboard.js';
import { buildWorkflowRepairPlan, registerAndRerunRepair } from '../runtime/workflow-repair.js';

// In-memory storage for active recording session
let activeRecording = null;
const savedSessions = [];

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

    const { type, selector, value } = req.body;
    activeRecording.steps.push({
      type,
      selector,
      value,
      timestamp: new Date().toISOString(),
    });

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
}

export function setupRepairPlanRoutes(app, { jobStore, workflowRegistry, jobRunner } = {}) {
  // Register and rerun repaired workflow
  app.post('/api/workflows/register-and-run', async (req, res) => {
    try {
      const { workflow, diagnostics, recipe, failedRequests } = req.body;

      if (!workflow) {
        return res.status(400).json({ error: 'workflow is required' });
      }

      // Build repair plan
      const repairPlan = buildWorkflowRepairPlan({
        workflow,
        diagnostics,
        recipe,
        failedRequests,
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
      const { workflow, diagnostics, recipe, failedRequests } = req.body;

      if (!workflow) {
        return res.status(400).json({ error: 'workflow is required' });
      }

      const repairPlan = buildWorkflowRepairPlan({
        workflow,
        diagnostics,
        recipe,
        failedRequests,
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
