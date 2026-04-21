/**
 * Example: Using Login Recorder and Repair Plan Quick Actions
 */

import { buildWorkflowRepairPlan, registerAndRerunRepair } from '../src/runtime/workflow-repair.js';

// ============================================================================
// Example 1: Generate Repair Plan
// ============================================================================

const failedWorkflow = {
  name: 'ecommerce-scraper',
  mode: 'http',
  seedUrls: ['https://shop.example.com/products'],
  extract: [
    { name: 'title', type: 'selector', selector: 'h1.product-title' },
    { name: 'price', type: 'selector', selector: '.price' },
  ],
};

const diagnostics = {
  suspects: [
    { type: 'auth-or-session-state', confidence: 0.8 },
    { type: 'signature-or-parameter-chain', confidence: 0.6 },
  ],
};

const failedRequests = [
  { url: 'https://shop.example.com/api/products', status: 401 },
  { url: 'https://shop.example.com/api/products', status: 403 },
];

// Generate repair plan
const repairPlan = buildWorkflowRepairPlan({
  workflow: failedWorkflow,
  diagnostics,
  failedRequests,
});

console.log('=== Repair Plan ===');
console.log('Suggested Workflow ID:', repairPlan.suggestedWorkflowId);
console.log('\nRepair Reasons:');
repairPlan.reasons.forEach((reason, i) => {
  console.log(`  ${i + 1}. ${reason}`);
});

console.log('\nQuick Actions:');
console.log('  Register and Rerun:', repairPlan.quickActions.registerAndRerun.enabled);
console.log('  Endpoint:', repairPlan.quickActions.registerAndRerun.endpoint);

console.log('\nPatch Applied:');
console.log(JSON.stringify(repairPlan.patch, null, 2));

// ============================================================================
// Example 2: One-Click Register and Rerun
// ============================================================================

async function exampleRegisterAndRerun() {
  // Mock dependencies (replace with real instances)
  const mockJobStore = {
    create: async (data) => ({
      id: `job-${Date.now()}`,
      ...data,
    }),
  };

  const mockWorkflowRegistry = {
    register: async (data) => {
      console.log(`✓ Registered workflow: ${data.id}`);
      return { success: true };
    },
  };

  const mockJobRunner = {
    run: async (jobId) => {
      console.log(`✓ Started job: ${jobId}`);
      return { success: true };
    },
  };

  // Execute one-click register and rerun
  const result = await registerAndRerunRepair({
    repairPlan,
    jobStore: mockJobStore,
    workflowRegistry: mockWorkflowRegistry,
    jobRunner: mockJobRunner,
  });

  console.log('\n=== Register and Rerun Result ===');
  console.log('Success:', result.success);
  console.log('Workflow ID:', result.workflowId);
  console.log('Job ID:', result.jobId);
  console.log('Message:', result.message);
}

// ============================================================================
// Example 3: Using HTTP API
// ============================================================================

async function exampleHttpApi() {
  // Preview repair plan
  const previewResponse = await fetch('http://localhost:3000/api/workflows/repair-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: failedWorkflow,
      diagnostics,
      failedRequests,
    }),
  });

  const plan = await previewResponse.json();
  console.log('\n=== HTTP API: Repair Plan Preview ===');
  console.log('Reasons:', plan.reasons);

  // One-click register and rerun
  const runResponse = await fetch('http://localhost:3000/api/workflows/register-and-run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: failedWorkflow,
      diagnostics,
      failedRequests,
    }),
  });

  const runResult = await runResponse.json();
  console.log('\n=== HTTP API: Register and Rerun ===');
  console.log('Job ID:', runResult.jobId);
  console.log('Workflow ID:', runResult.workflowId);
}

// ============================================================================
// Example 4: Login Recorder API
// ============================================================================

async function exampleLoginRecorder() {
  // Start recording
  const startResponse = await fetch('http://localhost:3000/api/login-recorder/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: 'https://example.com/login',
    }),
  });

  const recording = await startResponse.json();
  console.log('\n=== Login Recorder: Started ===');
  console.log('Recording ID:', recording.recording.id);

  // Simulate recording actions
  await fetch('http://localhost:3000/api/login-recorder/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'click',
      selector: '#username',
    }),
  });

  await fetch('http://localhost:3000/api/login-recorder/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'type',
      selector: '#username',
      value: 'user@example.com',
    }),
  });

  // Stop recording
  const stopResponse = await fetch('http://localhost:3000/api/login-recorder/stop', {
    method: 'POST',
  });

  const session = await stopResponse.json();
  console.log('\n=== Login Recorder: Stopped ===');
  console.log('Session ID:', session.session.id);
  console.log('Steps:', session.session.steps.length);
}

// Run examples
console.log('Running examples...\n');
await exampleRegisterAndRerun();
// await exampleHttpApi();  // Requires server running
// await exampleLoginRecorder();  // Requires server running
