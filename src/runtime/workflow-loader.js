import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateWorkflow } from '../schemas/workflow-schema.js';
import { getGlobalConfig } from '../utils/config.js';
import { validateCode, validateUrl } from '../utils/validation.js';

function applyGlobalWorkflowDefaults(input = {}) {
  const globalConfig = getGlobalConfig();
  return {
    ...input,
    concurrency: input.concurrency ?? globalConfig.get('performance.concurrency') ?? undefined,
    timeoutMs: input.timeoutMs ?? globalConfig.get('performance.timeout') ?? undefined,
  };
}

function isLoopbackUrl(url) {
  try {
    const hostname = new URL(String(url)).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function validateWorkflowUrl(url) {
  try {
    return validateUrl(url);
  } catch (error) {
    if (isLoopbackUrl(url)) {
      return validateUrl(url, { allowPrivateIPs: true });
    }
    throw error;
  }
}

function validateWorkflowSecuritySurface(workflow) {
  const checked = {
    ...workflow,
    seedUrls: (workflow.seedUrls ?? []).map((url) => validateWorkflowUrl(url)),
    seedRequests: (workflow.seedRequests ?? []).map((request) => ({
      ...request,
      url: validateWorkflowUrl(request.url),
    })),
    extract: (workflow.extract ?? []).map((rule) => ({
      ...rule,
      code: rule.code === undefined ? undefined : validateCode(rule.code),
    })),
  };

  return checked;
}

export async function loadWorkflow(input, { cwd = process.cwd() } = {}) {
  if (typeof input === 'string') {
    const filePath = resolve(cwd, input);
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      workflow: validateWorkflowSecuritySurface(validateWorkflow(applyGlobalWorkflowDefaults(parsed))),
      source: filePath,
    };
  }

  return {
    workflow: validateWorkflowSecuritySurface(validateWorkflow(applyGlobalWorkflowDefaults(input))),
    source: 'inline',
  };
}
