import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { appendNdjson, readJson, writeJson } from '../utils/fs.js';
import { sanitize } from '../utils/sanitizer.js';

function fingerprint(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function vaultKey(masterKey) {
  if (!masterKey) return null;
  return createHash('sha256').update(String(masterKey)).digest();
}

function encryptValue(value, masterKey) {
  const key = vaultKey(masterKey);
  if (!key) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(value ?? ''), 'utf8'),
    cipher.final(),
  ]);
  return {
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptValue(encrypted, masterKey) {
  const key = vaultKey(masterKey);
  if (!key || !encrypted?.ciphertext || encrypted.algorithm !== 'aes-256-gcm') {
    return null;
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export class AuditLogger {
  constructor({ path = null, actor = 'system' } = {}) {
    this.path = path;
    this.actor = actor;
    this.records = [];
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.path) return;
        try {
          const raw = await readFile(this.path, 'utf8');
          this.records = raw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              try {
                return JSON.parse(line);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        } catch {
          this.records = [];
        }
      })();
    }
    await this.initPromise;
    return this;
  }

  async record(action, details = {}) {
    await this.init();
    const record = {
      id: randomBytes(8).toString('hex'),
      at: new Date().toISOString(),
      actor: details.actor ?? this.actor,
      action,
      target: details.target ?? null,
      tenantId: details.tenantId ?? null,
      details: sanitize(details.details ?? {}),
    };
    this.records.push(record);
    if (this.path) {
      await appendNdjson(this.path, record);
    }
    return record;
  }

  list() {
    return [...this.records];
  }
}

export class CredentialVault {
  constructor({ path = null, masterKey = null } = {}) {
    this.path = path;
    this.masterKey = masterKey;
    this.items = new Map();
    this.initPromise = null;
    this.persistPromise = Promise.resolve();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.path) return;
        try {
          const loaded = await readJson(this.path);
          const items = Array.isArray(loaded?.items) ? loaded.items : [];
          this.items = new Map(items.map((item) => [item.id, { ...item, value: undefined }]));
        } catch {
          this.items = new Map();
        }
      })();
    }
    await this.initPromise;
    return this;
  }

  async persist() {
    if (!this.path) return;
    await writeJson(this.path, {
      version: 1,
      items: [...this.items.values()].map((item) => {
        const { value: _value, ...safe } = item;
        return safe;
      }),
    });
  }

  safePersist() {
    this.persistPromise = this.persistPromise
      .catch(() => {})
      .then(() => this.persist())
      .catch(() => {});
  }

  async flush() {
    await this.persistPromise;
  }

  put({ tenantId = 'default', name, value, scope = [] } = {}) {
    if (!name) throw new Error('credential name is required');
    const id = `${tenantId}:${name}`;
    const encryptedValue = encryptValue(value, this.masterKey);
    this.items.set(id, {
      id,
      tenantId,
      name,
      scope: Array.isArray(scope) ? [...scope] : [scope],
      value,
      encryptedValue,
      fingerprint: fingerprint(value),
      createdAt: new Date().toISOString(),
    });
    this.safePersist();
    return {
      id,
      tenantId,
      name,
      scope: Array.isArray(scope) ? [...scope] : [scope],
      fingerprint: fingerprint(value),
      persisted: Boolean(this.path),
      encryptedAtRest: Boolean(encryptedValue),
    };
  }

  resolve(id, { tenantId, scope } = {}) {
    const item = this.items.get(id);
    if (!item) return null;
    if (tenantId && item.tenantId !== tenantId) return null;
    if (scope && item.scope.length > 0 && !item.scope.includes(scope)) return null;
    return item.value ?? decryptValue(item.encryptedValue, this.masterKey);
  }

  describe(id) {
    const item = this.items.get(id);
    if (!item) return null;
    const { value: _value, ...safe } = item;
    return {
      ...safe,
      encryptedAtRest: Boolean(item.encryptedValue),
    };
  }
}

function matchPattern(pattern, value) {
  if (pattern === '*' || pattern === undefined || pattern === null) return true;
  const text = String(value ?? '');
  const source = String(pattern);
  if (source.endsWith('*')) {
    return text.startsWith(source.slice(0, -1));
  }
  return source === text;
}

function normalizePolicy(policy = {}, index = 0) {
  return {
    id: policy.id ?? `policy-${index + 1}`,
    effect: policy.effect === 'deny' ? 'deny' : 'allow',
    tenants: Array.isArray(policy.tenants) ? policy.tenants : [policy.tenantId ?? '*'],
    roles: Array.isArray(policy.roles) ? policy.roles : [policy.role ?? '*'],
    actions: Array.isArray(policy.actions) ? policy.actions : [policy.action ?? '*'],
    resources: Array.isArray(policy.resources) ? policy.resources : [policy.resource ?? '*'],
  };
}

export class AccessPolicy {
  constructor({ policies = [] } = {}) {
    this.policies = policies.map((policy, index) => normalizePolicy(policy, index));
  }

  add(policy) {
    const normalized = normalizePolicy(policy, this.policies.length);
    this.policies.push(normalized);
    return normalized;
  }

  evaluate({ tenantId = 'default', roles = [], action, resource = '*' } = {}) {
    const roleList = Array.isArray(roles) && roles.length > 0 ? roles : ['anonymous'];
    const matches = this.policies.filter((policy) =>
      policy.tenants.some((tenant) => matchPattern(tenant, tenantId))
      && policy.roles.some((role) => role === '*' || roleList.some((candidate) => matchPattern(role, candidate)))
      && policy.actions.some((candidate) => matchPattern(candidate, action))
      && policy.resources.some((candidate) => matchPattern(candidate, resource)));
    const denied = matches.find((policy) => policy.effect === 'deny');
    if (denied) {
      return { allowed: false, reason: 'explicit-deny', policyId: denied.id, matches };
    }
    const allowed = matches.find((policy) => policy.effect === 'allow');
    if (allowed) {
      return { allowed: true, reason: 'explicit-allow', policyId: allowed.id, matches };
    }
    return { allowed: false, reason: 'default-deny', policyId: null, matches };
  }

  list() {
    return [...this.policies];
  }
}

function normalizeTenant(tenant = {}, index = 0) {
  const now = new Date().toISOString();
  return {
    id: String(tenant.id ?? tenant.tenantId ?? `tenant-${index + 1}`),
    name: tenant.name ?? tenant.id ?? tenant.tenantId ?? `Tenant ${index + 1}`,
    status: tenant.status === 'disabled' ? 'disabled' : 'active',
    quotas: tenant.quotas && typeof tenant.quotas === 'object' && !Array.isArray(tenant.quotas)
      ? { ...tenant.quotas }
      : {},
    roles: Array.isArray(tenant.roles) ? [...tenant.roles] : [],
    metadata: tenant.metadata && typeof tenant.metadata === 'object' && !Array.isArray(tenant.metadata)
      ? { ...tenant.metadata }
      : {},
    createdAt: tenant.createdAt ?? now,
    updatedAt: now,
  };
}

export class TenantRegistry {
  constructor({ path = null, tenants = [] } = {}) {
    this.path = path;
    this.tenants = new Map(tenants.map((tenant, index) => {
      const normalized = normalizeTenant(tenant, index);
      return [normalized.id, normalized];
    }));
    this.initPromise = null;
    this.persistPromise = Promise.resolve();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.path) return;
        try {
          const loaded = await readJson(this.path);
          const tenants = Array.isArray(loaded?.tenants) ? loaded.tenants : [];
          this.tenants = new Map(tenants.map((tenant, index) => {
            const normalized = normalizeTenant(tenant, index);
            return [normalized.id, normalized];
          }));
        } catch {
          this.tenants = new Map();
        }
      })();
    }
    await this.initPromise;
    return this;
  }

  async persist() {
    if (!this.path) return;
    await writeJson(this.path, {
      version: 1,
      tenants: [...this.tenants.values()],
    });
  }

  safePersist() {
    this.persistPromise = this.persistPromise
      .catch(() => {})
      .then(() => this.persist())
      .catch(() => {});
  }

  async flush() {
    await this.persistPromise;
  }

  upsert(tenant = {}) {
    const id = String(tenant.id ?? tenant.tenantId ?? '').trim();
    if (!id) {
      throw new Error('tenant id is required');
    }
    const existing = this.tenants.get(id);
    const normalized = normalizeTenant({ ...(existing ?? {}), ...tenant, id }, this.tenants.size);
    if (existing?.createdAt) {
      normalized.createdAt = existing.createdAt;
    }
    this.tenants.set(id, normalized);
    this.safePersist();
    return { ...normalized };
  }

  setStatus(tenantId, status) {
    const tenant = this.tenants.get(tenantId);
    if (!tenant) return null;
    tenant.status = status === 'disabled' ? 'disabled' : 'active';
    tenant.updatedAt = new Date().toISOString();
    this.safePersist();
    return { ...tenant };
  }

  get(tenantId) {
    const tenant = this.tenants.get(tenantId);
    return tenant ? { ...tenant } : null;
  }

  list() {
    return [...this.tenants.values()].map((tenant) => ({ ...tenant }));
  }
}
