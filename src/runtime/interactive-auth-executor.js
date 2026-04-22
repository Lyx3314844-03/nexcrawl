import { readJson, writeJson } from '../utils/fs.js';

const SSO_RE = /(sso|saml|openid|oauth|authorize|identity provider|idp|企业登录|单点登录)/i;
const QR_RE = /(qr code|scan to login|扫码|二维码)/i;
const PASSKEY_RE = /(passkey|webauthn|security key|biometric|通行密钥|安全密钥)/i;
const RISK_RE = /(risk|unusual activity|verify your identity|账号风险|安全验证|风控|账户异常)/i;

function textOf(observation = {}) {
  return [observation.url, observation.finalUrl, observation.title, observation.body, observation.html, observation.text]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
}

function nowIso() {
  return new Date().toISOString();
}

export function classifyInteractiveAuthRequirement(observation = {}) {
  const text = textOf(observation);
  const url = String(observation.finalUrl ?? observation.url ?? '');
  const requirements = [];
  if (SSO_RE.test(text) || SSO_RE.test(url)) requirements.push('sso');
  if (QR_RE.test(text)) requirements.push('qr-login');
  if (PASSKEY_RE.test(text)) requirements.push('passkey-webauthn');
  if (RISK_RE.test(text) || Number(observation.status ?? 200) === 423) requirements.push('account-risk-review');

  return {
    required: requirements.length > 0,
    requirements,
    canAutoProceed: requirements.length === 0,
    requiresHuman: requirements.some((item) => ['qr-login', 'passkey-webauthn', 'account-risk-review'].includes(item)),
  };
}

export function buildInteractiveLoginPlan(observation = {}, options = {}) {
  const classification = classifyInteractiveAuthRequirement(observation);
  const steps = [];
  for (const requirement of classification.requirements) {
    if (requirement === 'sso') {
      steps.push({ type: 'follow-sso', provider: options.provider ?? 'auto-detect', mode: 'browser-assisted' });
    } else if (requirement === 'qr-login') {
      steps.push({ type: 'human-scan-qr', timeoutMs: Number(options.qrTimeoutMs ?? 120000) });
    } else if (requirement === 'passkey-webauthn') {
      steps.push({ type: 'human-passkey-confirm', timeoutMs: Number(options.passkeyTimeoutMs ?? 120000) });
    } else if (requirement === 'account-risk-review') {
      steps.push({ type: 'human-risk-review', quarantineAccount: options.quarantineAccount !== false });
    }
  }

  if (steps.length > 0) {
    steps.push({ type: 'capture-session-after-confirmation' });
  }

  return {
    kind: 'interactive-login-plan',
    classification,
    steps,
  };
}

export class HumanInteractionBroker {
  constructor({ defaultTimeoutMs = 300000, path = null } = {}) {
    this.path = path;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.challenges = new Map();
    this.initPromise = null;
    this.persistPromise = Promise.resolve();
  }

  async init() {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!this.path) return;
        try {
          const loaded = await readJson(this.path);
          const items = Array.isArray(loaded?.challenges) ? loaded.challenges : [];
          this.challenges = new Map(items.map((item) => [item.id, { ...item }]));
        } catch {
          this.challenges = new Map();
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
      challenges: [...this.challenges.values()],
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

  createChallenge({ type, tenantId = 'default', accountId = null, url = null, instructions = '', timeoutMs } = {}) {
    const id = `challenge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = nowIso();
    const item = {
      id,
      type,
      tenantId,
      accountId,
      url,
      instructions,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(Date.now() + Number(timeoutMs ?? this.defaultTimeoutMs)).toISOString(),
      result: null,
    };
    this.challenges.set(id, item);
    this.safePersist();
    return { ...item };
  }

  resolveChallenge(id, result = {}) {
    const item = this.challenges.get(id);
    if (!item) return null;
    item.status = result.ok === false ? 'rejected' : 'resolved';
    item.updatedAt = nowIso();
    item.result = { ...result };
    this.safePersist();
    return { ...item };
  }

  expireDue(now = Date.now()) {
    const expired = [];
    for (const item of this.challenges.values()) {
      if (item.status === 'pending' && Date.parse(item.expiresAt) <= now) {
        item.status = 'expired';
        item.updatedAt = nowIso();
        expired.push({ ...item });
      }
    }
    if (expired.length > 0) {
      this.safePersist();
    }
    return expired;
  }

  list({ status = null, tenantId = null } = {}) {
    this.expireDue();
    return [...this.challenges.values()]
      .filter((item) => !status || item.status === status)
      .filter((item) => !tenantId || item.tenantId === tenantId)
      .map((item) => ({ ...item }));
  }
}
