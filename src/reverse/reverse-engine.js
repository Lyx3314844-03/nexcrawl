/**
 * ReverseEngine - Orchestrator for all reverse engineering capabilities.
 * Manages configuration state, applies stealth/challenge-solving to the crawl pipeline,
 * and provides analysis methods for use in route handlers.
 */
export class ReverseEngine {
  constructor(config = {}) {
    this.stealth = config.stealth ?? false;
    this.cloudflare = config.cloudflare ?? false;
    this.captcha = config.captcha ?? null;
    this.challenge = config.challenge ?? null;
    this.behaviorSim = config.behaviorSim ?? false;
    this.appWebView = config.appWebView ?? null;
    this.reverseAnalysis = config.reverseAnalysis ?? false;
    this.tlsProfile = config.tlsProfile ?? null;
    this.h2Profile = config.h2Profile ?? null;
    this._reverseCapabilities = null;
    this._stealthProfile = null;
    this._cloudflareSolver = null;
    this._captchaSolver = null;
    this._behaviorSim = null;
    this._appWebView = null;
  }

  /** Unwrap ESM dynamic import() namespace object - handles both { default: X } and direct module exports */
  _unwrap(mod) {
    if (!mod) return mod;
    if (typeof mod === "object" && mod.default && Object.keys(mod).length <= 2) return mod.default;
    return mod;
  }

  get enabled() {
    return !!(this.stealth || this.cloudflare || this.captcha || this.challenge || this.behaviorSim || this.appWebView || this.reverseAnalysis || this.tlsProfile || this.h2Profile);
  }

  get requiresBrowser() {
    return !!(this.stealth || this.cloudflare || this.captcha || this.challenge || this.behaviorSim || this.appWebView);
  }

  isChallengeResponse(response = {}) {
    const policy = this.challenge ?? {};
    const statuses = Array.isArray(policy.statuses) ? policy.statuses : [403, 429, 503];
    const bodyPatterns = Array.isArray(policy.bodyPatterns) ? policy.bodyPatterns : [];
    const status = Number(response.status ?? response.statusCode ?? 0);
    const body = String(response.body ?? '').toLowerCase();

    if (statuses.includes(status)) {
      return true;
    }

    return bodyPatterns.some((pattern) => body.includes(String(pattern).toLowerCase()));
  }

  async validateChallengeResolution(page, options = {}) {
    const policy = this.challenge?.validate ?? {};
    if (policy.enabled === false) {
      return {
        validated: true,
        reasons: [],
      };
    }

    const cookies = await page.cookies().catch(() => []);
    const successCookieNames = Array.isArray(policy.successCookieNames) ? policy.successCookieNames : ['cf_clearance'];
    const matchedCookie = cookies.find((entry) => successCookieNames.includes(entry.name));
    const html = await page.content().catch(() => '');
    const lowered = String(html).toLowerCase();
    const absencePatterns = Array.isArray(policy.absencePatterns) ? policy.absencePatterns : [];
    const blockingPatterns = absencePatterns.filter((pattern) => lowered.includes(String(pattern).toLowerCase()));
    const validated = Boolean(matchedCookie) || blockingPatterns.length === 0;

    return {
      validated,
      reasons: [
        ...(matchedCookie ? [`cookie:${matchedCookie.name}`] : []),
        ...blockingPatterns.map((pattern) => `pattern:${pattern}`),
      ],
      pageUrl: page.url?.() ?? null,
    };
  }

  async _loadReverseCapabilities() {
    if (!this._reverseCapabilities) { this._reverseCapabilities = this._unwrap(await import("../reverse/reverse-capabilities.js")); }
    return this._reverseCapabilities;
  }
  async _loadStealthProfile() {
    if (!this._stealthProfile) { this._stealthProfile = this._unwrap(await import("../reverse/stealth-profile.js")); }
    return this._stealthProfile;
  }
  async _loadCloudflareSolver() {
    if (!this._cloudflareSolver) { this._cloudflareSolver = this._unwrap(await import("../reverse/cloudflare-solver.js")); }
    return this._cloudflareSolver;
  }
  async _loadCaptchaSolver() {
    if (!this._captchaSolver) { this._captchaSolver = this._unwrap(await import("../reverse/captcha-solver.js")); }
    return this._captchaSolver;
  }
  async _loadBehaviorSim() {
    if (!this._behaviorSim) { this._behaviorSim = this._unwrap(await import("../reverse/behavior-simulation.js")); }
    return this._behaviorSim;
  }
  async _loadAppWebView() {
    if (!this._appWebView) { this._appWebView = this._unwrap(await import("../reverse/app-webview.js")); }
    return this._appWebView;
  }

  async setupBrowserContext(page, options = {}) {
    if (this.stealth) {
      const mod = await this._loadStealthProfile();
      const opts = typeof this.stealth === "object" ? { ...this.stealth, ...options } : options;
      const hookCode = mod.buildAntiDetectionHook(opts);
      if (typeof page.evaluateOnNewDocument === 'function') {
        await page.evaluateOnNewDocument(hookCode);
      } else if (typeof page.addInitScript === 'function') {
        await page.addInitScript(hookCode);
      } else {
        throw new Error('Browser page does not support init script injection');
      }
      const cdp = typeof page.createCDPSession === 'function'
        ? await page.createCDPSession().catch(() => null)
        : null;
      if (cdp) { await mod.applyStealthProfile({ page, cdp, options: opts }); }
    }
    if (this.appWebView) {
      const mod = await this._loadAppWebView();
      const appType = typeof this.appWebView === "string" ? this.appWebView : this.appWebView.type ?? "android-webview";
      const opts = typeof this.appWebView === "object" ? { ...this.appWebView } : {};
      await mod.injectAppWebView(page, appType, opts);
    }
    if (this.behaviorSim) {
      const mod = await this._loadBehaviorSim();
      const opts = typeof this.behaviorSim === "object" ? this.behaviorSim : {};
      await mod.injectBehaviorSimulation(page, opts);
    }
  }

  async resolveChallenge(page, response) {
    if (this.cloudflare) {
      const mod = await this._loadCloudflareSolver();
      const opts = typeof this.cloudflare === "object" ? this.cloudflare : {};
      try {
        const result = await mod.handleCloudflareChallenge(page, {
          ...opts,
          maxWaitMs: opts.maxWaitMs ?? opts.timeout ?? 30000,
        });
        if (result?.success) {
          return {
            solved: true,
            type: result.method?.includes('turnstile') ? 'turnstile' : 'cloudflare',
            token: result.solution?.solution ?? result.token ?? null,
          };
        }
      } catch (e) { /* continue to captcha */ }
    }
    if (this.captcha) {
      const mod = await this._loadCaptchaSolver();
      try {
        const detected = await mod.detectCaptcha(page);
        if (detected?.present || detected) {
          const result = await mod.autoSolveCaptcha(page, {
            service: this.captcha.provider ?? this.captcha.service ?? "capsolver",
            apiKey: this.captcha.apiKey,
            maxWaitMs: this.captcha.maxWaitMs ?? 120000,
          });
          return {
            solved: Boolean(result?.solved),
            type: detected.type ?? null,
            token: result?.solved?.solution ?? null,
          };
        }
      } catch (e) { /* captcha solver failed */ }
    }
    return { solved: false, type: null, token: null };
  }

  async runReverseOperation(operation, payload = {}) {
    if (!this.enabled) { return { success: false, error: "ReverseEngine not enabled" }; }
    const cap = await this._loadReverseCapabilities();
    return cap.runReverseOperation({ operation, ...payload });
  }

  async analyzeJS(code, options = {}) {
    try { return await this.runReverseOperation("analyze", { code, ...options }); }
    catch (e) { return { success: false, error: e.message }; }
  }

  async analyzeCrypto(code, options = {}) {
    try { return await this.runReverseOperation("crypto.identify", { code, ...options }); }
    catch (e) { return { success: false, error: e.message }; }
  }

  async analyzeWebpack(code, options = {}) {
    try { return await this.runReverseOperation("webpack.analyze", { code, ...options }); }
    catch (e) { return { success: false, error: e.message }; }
  }

  async locateSignature(code, options = {}) {
    try { return await this.runReverseOperation("signature.locate", { code, ...options }); }
    catch (e) { return { success: false, error: e.message }; }
  }

  async summarizeWorkflow(html, options = {}) {
    if (!this.enabled) { return { success: false, error: "ReverseEngine not enabled" }; }
    const cap = await this._loadReverseCapabilities();
    try { return await cap.summarizeWorkflow({ html, ...options }); }
    catch (e) { return { success: false, error: e.message }; }
  }

  async analyzeAISurface(payload = {}) {
    if (!this.enabled) { return { success: false, error: "ReverseEngine not enabled" }; }
    const cap = await this._loadReverseCapabilities();
    try { return await cap.runReverseOperation({ operation: 'ai.analyze', ...payload }); }
    catch (e) { return { success: false, error: e.message }; }
  }

  async generateHookCode(options = {}) {
    if (!this.enabled) { return ""; }
    const cap = await this._loadReverseCapabilities();
    return cap.generateHookCode(options);
  }

  async simulateBrowser(payload = {}) {
    if (!this.enabled) { return { success: false, error: "ReverseEngine not enabled" }; }
    const cap = await this._loadReverseCapabilities();
    try { return await cap.simulateBrowser(payload); }
    catch (e) { return { success: false, error: e.message }; }
  }

  async simulateHumanBehavior(page, options = {}) {
    if (!this.behaviorSim) { return; }
    const mod = await this._loadBehaviorSim();
    const opts = typeof this.behaviorSim === "object" ? { ...this.behaviorSim, ...options } : options;
    const events = mod.generateInteractionSequence({}, opts);
    await mod.executeInteractionSequence(page, events, { delayFactor: 0.5, ...opts });
  }

  async getCapabilitySnapshot() {
    if (!this.enabled) { return { capabilities: [] }; }
    const cap = await this._loadReverseCapabilities();
    return cap.getReverseCapabilitySnapshot();
  }
}
