import { readJson, writeJson } from '../utils/fs.js';

function nowMs() {
  return Date.now();
}

function normalizeAccount(account = {}, index = 0) {
  return {
    id: account.id ?? account.username ?? `account-${index + 1}`,
    tenantId: account.tenantId ?? 'default',
    siteId: account.siteId ?? account.site ?? '*',
    username: account.username ?? null,
    labels: Array.isArray(account.labels) ? [...account.labels] : [],
    weight: Math.max(1, Number(account.weight ?? 1) || 1),
    disabled: account.disabled === true,
    cooldownUntil: Number(account.cooldownUntil ?? 0),
    leasedUntil: 0,
    successCount: Number(account.successCount ?? 0),
    failureCount: Number(account.failureCount ?? 0),
    consecutiveFailures: Number(account.consecutiveFailures ?? 0),
    lastSelectedAt: Number(account.lastSelectedAt ?? 0),
    score: Number(account.score ?? 100),
    metadata: account.metadata ?? {},
  };
}

function matchesScope(account, scope = {}) {
  if (scope.tenantId && account.tenantId !== scope.tenantId) return false;
  if (scope.siteId && account.siteId !== '*' && account.siteId !== scope.siteId) return false;
  if (scope.labels?.length && !scope.labels.every((label) => account.labels.includes(label))) return false;
  return true;
}

export class AccountPool {
  constructor({ accounts = [], leaseMs = 300000, cooldownMs = 600000, maxConsecutiveFailures = 3, path = null } = {}) {
    this.path = path;
    this.leaseMs = leaseMs;
    this.cooldownMs = cooldownMs;
    this.maxConsecutiveFailures = maxConsecutiveFailures;
    this.accounts = new Map(accounts.map((account, index) => {
      const normalized = normalizeAccount(account, index);
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
          this.leaseMs = Number(loaded?.leaseMs ?? this.leaseMs);
          this.cooldownMs = Number(loaded?.cooldownMs ?? this.cooldownMs);
          this.maxConsecutiveFailures = Number(loaded?.maxConsecutiveFailures ?? this.maxConsecutiveFailures);
          const accounts = Array.isArray(loaded?.accounts) ? loaded.accounts : [];
          this.accounts = new Map(accounts.map((account, index) => {
            const normalized = normalizeAccount(account, index);
            return [normalized.id, normalized];
          }));
        } catch {
          this.accounts = new Map();
        }
      })();
    }
    await this.initPromise;
    return this;
  }

  snapshotState() {
    return {
      version: 1,
      leaseMs: this.leaseMs,
      cooldownMs: this.cooldownMs,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
      accounts: [...this.accounts.values()],
    };
  }

  async persist() {
    if (!this.path) return;
    await writeJson(this.path, this.snapshotState());
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

  upsert(account) {
    const existing = this.accounts.get(account.id ?? account.username);
    const normalized = normalizeAccount({ ...(existing ?? {}), ...account }, this.accounts.size);
    this.accounts.set(normalized.id, normalized);
    this.safePersist();
    return { ...normalized };
  }

  lease(scope = {}, now = nowMs()) {
    const candidates = [...this.accounts.values()]
      .filter((account) => !account.disabled)
      .filter((account) => account.cooldownUntil <= now)
      .filter((account) => account.leasedUntil <= now)
      .filter((account) => matchesScope(account, scope))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.weight !== left.weight) return right.weight - left.weight;
        return left.lastSelectedAt - right.lastSelectedAt;
      });

    const selected = candidates[0] ?? null;
    if (!selected) return null;
    selected.leasedUntil = now + Number(scope.leaseMs ?? this.leaseMs);
    selected.lastSelectedAt = now;
    this.safePersist();
    return { ...selected };
  }

  release(accountId, result = {}, now = nowMs()) {
    const account = this.accounts.get(accountId);
    if (!account) return null;
    account.leasedUntil = 0;
    if (result.ok === false) {
      account.failureCount += 1;
      account.consecutiveFailures += 1;
      account.score = Math.max(0, account.score - Number(result.penalty ?? 20));
      if (account.consecutiveFailures >= this.maxConsecutiveFailures || result.quarantine === true) {
        account.cooldownUntil = now + Number(result.cooldownMs ?? this.cooldownMs);
        account.consecutiveFailures = 0;
      }
    } else {
      account.successCount += 1;
      account.consecutiveFailures = 0;
      account.score = Math.min(100, account.score + Number(result.reward ?? 5));
    }
    this.safePersist();
    return { ...account };
  }

  setEnabled(accountId, enabled) {
    const account = this.accounts.get(accountId);
    if (!account) return null;
    account.disabled = !enabled;
    if (enabled) {
      account.cooldownUntil = 0;
      account.leasedUntil = 0;
    }
    this.safePersist();
    return { ...account };
  }

  remove(accountId) {
    const removed = this.accounts.delete(accountId);
    if (removed) {
      this.safePersist();
    }
    return removed;
  }

  snapshot() {
    return [...this.accounts.values()].map((account) => ({
      ...account,
      available: !account.disabled && account.cooldownUntil <= nowMs() && account.leasedUntil <= nowMs(),
    }));
  }
}
