import { join, resolve } from 'node:path';
import { ensureDir, readJson, writeJson } from '../utils/fs.js';
import { hashText } from '../utils/hash.js';

function nowIso() {
  return new Date().toISOString();
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePoolConfig(config = {}) {
  return {
    enabled: config.enabled === true,
    id: config.id ?? null,
    maxSessions: Math.max(1, Number(config.maxSessions ?? 5)),
    maxFailures: Math.max(1, Number(config.maxFailures ?? 2)),
    retireAfterUses: Math.max(1, Number(config.retireAfterUses ?? 50)),
    bindProxy: config.bindProxy !== false,
    strategy: config.strategy === 'roundRobin' ? 'roundRobin' : 'leastUsed',
  };
}

function createState(poolId) {
  const now = nowIso();
  return {
    version: 1,
    poolId,
    createdAt: now,
    updatedAt: now,
    cursor: 0,
    sessions: [],
  };
}

export class SessionPool {
  constructor({ projectRoot = process.cwd(), poolId, config = {} } = {}) {
    this.projectRoot = projectRoot;
    this.config = normalizePoolConfig(config);
    this.poolId = poolId ?? this.config.id ?? `pool_${hashText(nowIso()).slice(0, 12)}`;
    this.storageDir = resolve(projectRoot, '.omnicrawl', 'session-pools');
    this.statePath = join(this.storageDir, `${hashText(this.poolId).slice(0, 12)}.json`);
    this.state = createState(this.poolId);
    this.initPromise = null;
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await ensureDir(this.storageDir);

        try {
          const loaded = await readJson(this.statePath);
          this.state = loaded?.poolId ? loaded : createState(this.poolId);
        } catch {
          this.state = createState(this.poolId);
          await this.persist();
        }
      })();
    }

    await this.initPromise;
    return this;
  }

  async persist() {
    this.state.updatedAt = nowIso();
    await writeJson(this.statePath, this.state);
  }

  snapshot() {
    return {
      poolId: this.poolId,
      updatedAt: this.state.updatedAt,
      sessions: structuredClone(this.state.sessions),
    };
  }

  nextSessionId() {
    return `${this.poolId}:s${String(this.state.sessions.length + 1).padStart(3, '0')}`;
  }

  createSession() {
    const now = nowIso();
    return {
      id: this.nextSessionId(),
      status: 'active',
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      useCount: 0,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      boundProxy: null,
      boundIdentityProfile: null,
      retiredAt: null,
    };
  }

  activeSessions() {
    return this.state.sessions.filter((item) => item.status === 'active');
  }

  selectActiveSession() {
    const sessions = this.activeSessions();
    if (sessions.length === 0) {
      return null;
    }

    if (this.config.strategy === 'roundRobin') {
      const selected = sessions[this.state.cursor % sessions.length];
      this.state.cursor = (this.state.cursor + 1) % sessions.length;
      return selected;
    }

    return [...sessions].sort((left, right) => {
      if (left.useCount !== right.useCount) {
        return left.useCount - right.useCount;
      }

      return String(left.lastUsedAt ?? '').localeCompare(String(right.lastUsedAt ?? ''));
    })[0];
  }

  async acquire() {
    await this.init();

    let session = this.selectActiveSession();
    if (!session && this.state.sessions.length < this.config.maxSessions) {
      session = this.createSession();
      this.state.sessions.push(session);
    }

    if (!session) {
      session = [...this.state.sessions].sort((left, right) => String(left.updatedAt).localeCompare(String(right.updatedAt)))[0] ?? this.createSession();
      if (!this.state.sessions.includes(session)) {
        this.state.sessions.push(session);
      }
      session.status = 'active';
      session.consecutiveFailures = 0;
      session.lastError = null;
      session.retiredAt = null;
    }

    session.useCount += 1;
    session.lastUsedAt = nowIso();
    session.updatedAt = session.lastUsedAt;
    if (session.useCount >= this.config.retireAfterUses) {
      session.status = 'retired';
      session.retiredAt = session.updatedAt;
    }

    await this.persist();
    return structuredClone(session);
  }

  findSession(sessionId) {
    return this.state.sessions.find((item) => item.id === sessionId) ?? null;
  }

  async bindProxy(sessionId, proxy) {
    if (!this.config.bindProxy || !proxy?.server) {
      return null;
    }

    await this.init();
    const session = this.findSession(sessionId);
    if (!session) {
      return null;
    }

    session.boundProxy = {
      server: proxy.server,
      label: proxy.label ?? null,
      username: proxy.username ?? null,
      password: proxy.password ?? null,
      region: proxy.region ?? null,
      country: proxy.country ?? null,
      city: proxy.city ?? null,
      bypass: proxy.bypass ?? [],
    };
    session.updatedAt = nowIso();
    await this.persist();
    return structuredClone(session);
  }

  async bindIdentityProfile(sessionId, profile) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      return null;
    }

    await this.init();
    const session = this.findSession(sessionId);
    if (!session) {
      return null;
    }

    session.boundIdentityProfile = structuredClone(profile);
    session.updatedAt = nowIso();
    await this.persist();
    return structuredClone(session);
  }

  async resolveBoundIdentityProfile(sessionId) {
    await this.init();
    const session = this.findSession(sessionId);
    return session?.boundIdentityProfile ? structuredClone(session.boundIdentityProfile) : null;
  }

  async reportSuccess(sessionId) {
    await this.init();
    const session = this.findSession(sessionId);
    if (!session) {
      return null;
    }

    session.successCount += 1;
    session.consecutiveFailures = 0;
    session.lastSuccessAt = nowIso();
    session.updatedAt = session.lastSuccessAt;
    await this.persist();
    return structuredClone(session);
  }

  async reportFailure(sessionId, { message } = {}) {
    await this.init();
    const session = this.findSession(sessionId);
    if (!session) {
      return null;
    }

    session.failureCount += 1;
    session.consecutiveFailures += 1;
    session.lastFailureAt = nowIso();
    session.updatedAt = session.lastFailureAt;
    session.lastError = message ?? null;

    if (session.consecutiveFailures >= this.config.maxFailures) {
      session.status = 'retired';
      session.retiredAt = session.updatedAt;
    }

    await this.persist();
    return structuredClone(session);
  }

  async list() {
    await this.init();
    return structuredClone(this.state.sessions);
  }

  async resolveBoundProxy(sessionId) {
    await this.init();
    const session = this.findSession(sessionId);
    return session?.boundProxy ? structuredClone(session.boundProxy) : null;
  }
}
