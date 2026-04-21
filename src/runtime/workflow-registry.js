import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { slugify } from '../utils/slug.js';
import { validateWorkflow } from '../schemas/workflow-schema.js';

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildWorkflowId(base) {
  return `${slugify(base) || 'workflow'}-${Math.random().toString(36).slice(2, 6)}`;
}

export class WorkflowRegistry {
  constructor({ projectRoot = process.cwd() } = {}) {
    this.projectRoot = projectRoot;
    this.storageDir = resolve(projectRoot, '.omnicrawl');
    this.workflowsDir = join(this.storageDir, 'workflows');
    this.indexPath = join(this.storageDir, 'workflows-index.json');
    this.index = [];
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);
        await ensureDir(this.workflowsDir);

        try {
          this.index = toArray(await readJson(this.indexPath));
        } catch {
          this.index = [];
          await writeJson(this.indexPath, this.index);
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  list() {
    return [...this.index].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  get(workflowId) {
    const entry = this.index.find((item) => item.id === workflowId);

    if (!entry) {
      return undefined;
    }

    const workflow = JSON.parse(readFileSync(join(this.workflowsDir, `${workflowId}.json`), 'utf8'));
    return {
      ...entry,
      workflow,
    };
  }

  async register({ workflow, id, source = 'inline', description = '' }) {
    await this.init();
    const normalizedWorkflow = {
      ...workflow,
      seedUrls: Array.isArray(workflow?.seedUrls) && workflow.seedUrls.length > 0
        ? workflow.seedUrls
        : (Array.isArray(workflow?.seedRequests) ? workflow.seedRequests.map((entry) => entry?.url).filter(Boolean) : []),
    };
    const validated = validateWorkflow(normalizedWorkflow);
    const workflowId = id ? slugify(id) : buildWorkflowId(validated.name);
    const now = new Date().toISOString();
    const previous = this.index.find((item) => item.id === workflowId);

    const entry = {
      id: workflowId,
      name: validated.name,
      source,
      description,
      updatedAt: now,
      createdAt: previous?.createdAt ?? now,
    };

    this.index = this.index.filter((item) => item.id !== workflowId);
    this.index.unshift(entry);

    await writeJson(join(this.workflowsDir, `${workflowId}.json`), validated);
    await writeJson(this.indexPath, this.index);

    return {
      ...entry,
      workflow: validated,
    };
  }
}
