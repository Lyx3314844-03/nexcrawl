const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|sso|oauth|authorize)(\/|$|\?)/i;
const PASSWORD_RE = /<input[^>]+type=["']password["']/i;
const MFA_RE = /(mfa|2fa|two[-\s]?factor|verification code|otp|一次性|验证码|二次验证)/i;
const CAPTCHA_RE = /(captcha|recaptcha|hcaptcha|geetest|turnstile|验证码)/i;
const QR_RE = /(qr code|scan to login|扫码|二维码)/i;
const RISK_RE = /(risk|unusual activity|verify your identity|账号风险|安全验证|风控|账户异常)/i;
const PASSKEY_RE = /(passkey|webauthn|security key|biometric|通行密钥|安全密钥)/i;
const SUCCESS_RE = /(logout|sign out|dashboard|my account|profile|退出登录|个人中心|账户中心)/i;
const EXPIRED_RE = /(session expired|token expired|please login again|登录已过期|会话过期|unauthorized)/i;

function textOf(observation = {}) {
  return [observation.url, observation.finalUrl, observation.title, observation.body, observation.html, observation.text]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
}

function lowerHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [String(key).toLowerCase(), value]));
}

function includesAny(text, patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractSignals(observation = {}) {
  const rawText = textOf(observation);
  const lowerText = rawText.toLowerCase();
  const headers = lowerHeaders(observation.headers);
  const status = Number(observation.status ?? 200);
  const url = String(observation.finalUrl ?? observation.url ?? '');
  const cookies = Array.isArray(observation.cookies) ? observation.cookies : [];
  const tokenCount = Object.keys(observation.tokens ?? observation.replayState ?? {}).length;

  return {
    status,
    url,
    loginUrl: LOGIN_URL_RE.test(url) || LOGIN_URL_RE.test(String(headers.location ?? '')),
    passwordField: PASSWORD_RE.test(rawText),
    captcha: CAPTCHA_RE.test(lowerText),
    mfa: includesAny(lowerText, [MFA_RE]),
    qr: QR_RE.test(lowerText),
    passkey: PASSKEY_RE.test(lowerText),
    risk: RISK_RE.test(lowerText) || status === 423,
    oauth: /oauth|authorize|openid|saml|sso/i.test(url) || /idp|identity provider/i.test(lowerText),
    redirecting: [301, 302, 303, 307, 308].includes(status),
    successCopy: SUCCESS_RE.test(lowerText),
    expiredCopy: EXPIRED_RE.test(lowerText),
    unauthorized: [401, 403, 419, 440].includes(status),
    hasSessionArtifacts: cookies.length > 0 || tokenCount > 0 || Boolean(headers['set-cookie']),
  };
}

function scoreState(signals) {
  if (signals.passkey) return ['manual_required', ['passkey-webauthn']];
  if (signals.qr) return ['manual_required', ['qr-login']];
  if (signals.risk) return ['risk_challenge', ['account-risk']];
  if (signals.captcha) return ['captcha_challenge', ['captcha']];
  if (signals.mfa) return ['mfa_challenge', ['mfa']];
  if (signals.oauth && signals.redirecting) return ['sso_redirect', ['oauth-sso-redirect']];
  if (signals.unauthorized || signals.expiredCopy) return ['expired', ['auth-expired']];
  if (signals.passwordField || signals.loginUrl) return ['login_page', ['login-form']];
  if (signals.successCopy || signals.hasSessionArtifacts) return ['authenticated', ['session-artifacts']];
  if (signals.redirecting) return ['redirecting', ['http-redirect']];
  return ['unknown', []];
}

export function classifyLoginObservation(observation = {}) {
  const signals = extractSignals(observation);
  const [state, reasons] = scoreState(signals);
  return {
    state,
    authenticated: state === 'authenticated',
    terminal: ['authenticated', 'manual_required', 'risk_challenge'].includes(state),
    recoverable: ['expired', 'login_page', 'captcha_challenge', 'mfa_challenge', 'redirecting', 'sso_redirect'].includes(state),
    reasons,
    signals,
  };
}

export function buildLoginRecoveryPlan(classification = {}, options = {}) {
  const state = classification.state ?? 'unknown';
  const accountId = options.accountId ?? null;
  const steps = [];
  const manual = [];

  if (state === 'expired') {
    steps.push({ type: 'renew-session', accountId, strategy: options.renewStrategy ?? 'refresh-token-or-replay' });
  } else if (state === 'login_page') {
    steps.push({ type: 'fill-credentials', accountId });
    steps.push({ type: 'submit-login' });
    steps.push({ type: 'wait-for-success', success: options.success ?? {} });
  } else if (state === 'captcha_challenge') {
    steps.push({ type: 'solve-captcha', provider: options.captchaProvider ?? 'manual-or-configured' });
    steps.push({ type: 'resume-login' });
  } else if (state === 'mfa_challenge') {
    steps.push({ type: 'solve-mfa', provider: options.mfaProvider ?? 'totp-or-human' });
    steps.push({ type: 'resume-login' });
  } else if (state === 'sso_redirect') {
    steps.push({ type: 'follow-sso-redirect', provider: options.ssoProvider ?? 'auto-detect' });
    manual.push('enterprise-oauth-or-saml-policy-may-require-admin-consent');
  } else if (state === 'manual_required') {
    manual.push(...(classification.reasons ?? ['manual-confirmation']));
  } else if (state === 'risk_challenge') {
    steps.push({ type: 'quarantine-account', accountId, reason: 'risk-challenge' });
    manual.push('account-risk-review');
  }

  return {
    kind: 'login-recovery-plan',
    state,
    accountId,
    canAutoRecover: steps.length > 0 && manual.length === 0,
    requiresHuman: manual.length > 0,
    steps,
    manual,
  };
}

export class LoginStateMachine {
  constructor(options = {}) {
    this.options = options;
    this.state = 'unknown';
    this.history = [];
  }

  observe(observation = {}) {
    const classification = classifyLoginObservation(observation);
    this.state = classification.state;
    const event = {
      at: new Date().toISOString(),
      observationId: observation.id ?? null,
      ...classification,
    };
    this.history.push(event);
    return event;
  }

  plan(options = {}) {
    const current = this.history[this.history.length - 1] ?? { state: this.state };
    return buildLoginRecoveryPlan(current, { ...this.options, ...options });
  }

  isSessionExpiring(session = {}, nowMs = Date.now()) {
    const renewBeforeMs = Number(this.options.renewBeforeMs ?? 300000);
    const expiresAt = Number(session.expiresAtMs ?? session.expiresAt ?? 0);
    if (!expiresAt) return false;
    return expiresAt - nowMs <= renewBeforeMs;
  }
}
