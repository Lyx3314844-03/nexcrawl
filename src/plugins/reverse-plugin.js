import {
  applySignerInjectionToRequest,
  captureSignerArtifactFromResponse,
} from '../runtime/reverse-signer-runtime.js';

/**
 * ReversePlugin - Middleware plugin that integrates reverse engineering capabilities
 * into the JobRunner pipeline. Automatically applies stealth profiles,
 * detects and solves challenges (Cloudflare, Captcha), and enriches
 * CrawlContext with analysis methods.
 *
 * Hook integration points:
 * - beforeRequest: Apply stealth headers/TLS profile for HTTP fetcher
 * - afterResponse: Detect blocked responses (403/503/429), attempt challenge solving
 * - afterExtract: Run reverse analysis on extracted content if configured
 * - onError: Retry with challenge-solving on specific errors
 */
export class ReversePlugin {
  /**
   * @param {import('../reverse/reverse-engine.js').ReverseEngine} engine - Configured ReverseEngine instance
   * @param {Object} [options]
   * @param {number} [options.maxChallengeRetries=2] - Max retries for solving challenges
   * @param {number[]} [options.challengeStatusCodes] - Status codes that trigger challenge solving
   * @param {boolean} [options.autoBehaviorSim=false] - Auto-run behavior simulation after page load
   * @param {boolean} [options.autoReverseAnalysis=false] - Auto-analyze JS on every page
   */
  constructor(engine, options = {}) {
    if (!engine || !engine.enabled) {
      throw new Error('ReversePlugin requires an enabled ReverseEngine instance');
    }
    this.engine = engine;
    this.maxChallengeRetries = options.maxChallengeRetries ?? options.workflow?.reverse?.challenge?.maxSolveAttempts ?? 2;
    this.challengeStatusCodes = options.challengeStatusCodes ?? options.workflow?.reverse?.challenge?.statuses ?? [403, 503, 429];
    this.autoBehaviorSim = options.autoBehaviorSim ?? false;
    this.autoReverseAnalysis = options.autoReverseAnalysis ?? false;
    this.workflow = options.workflow ?? {};
    this.assetStore = options.assetStore ?? null;
    this._challengeRetryCount = new Map();
    this._log = { info: (...a) => {}, warn: (...a) => {}, error: (...a) => {}, debug: (...a) => {} };
  }

  /**
   * Create a hook object compatible with PluginManager's plugins array.
   * @param {Object} [logger] - Optional logger
   * @returns {Object} Plugin object with hook methods
   */
  createPlugin(logger) {
    if (logger) this._log = logger;
    return {
      name: 'omnicrawler-reverse',
      beforeRequest: async (payload) => {
        // Apply stealth headers and TLS profile for HTTP mode
        if (payload?.request) {
          if (this.engine.tlsProfile) {
            payload.request.tlsProfile = this.engine.tlsProfile;
          }
          if (this.engine.h2Profile) {
            payload.request.h2Profile = this.engine.h2Profile;
          }

          await applySignerInjectionToRequest(
            payload.request,
            {
              ...(this.workflow.signer ?? {}),
              workflowName: this.workflow.name,
            },
            this.assetStore,
          ).catch((error) => {
            this._log.debug('signer injection skipped', {
              url: payload.request.url,
              error: error?.message ?? String(error),
            });
          });
        }
      },
      afterResponse: async (payload) => {
        const response = payload?.response;
        if (!response) return {};
        const status = response.status ?? response.statusCode ?? 200;
        const url = payload?.request?.url ?? '';
        const existingChallenge = response.challenge ?? null;
        const challengeDetected =
          existingChallenge?.detected === true
          || this.challengeStatusCodes.includes(status)
          || this.engine.isChallengeResponse(response);

        const result = {};
        if (challengeDetected) {
          const retryCount = this._challengeRetryCount.get(url) ?? 0;
          const challenge = {
            detected: true,
            solved: existingChallenge?.solved === true,
            validated: existingChallenge?.validated === true,
            type: existingChallenge?.type ?? null,
            attribution: this.workflow.reverse?.challenge?.attribution ?? 'challenge',
            sessionAction: this.workflow.reverse?.challenge?.sessionAction ?? 'reportFailure',
            proxyAction: this.workflow.reverse?.challenge?.proxyAction ?? 'reportFailure',
            shouldRetry:
              existingChallenge?.shouldRetry
              ?? (
                retryCount < (this.workflow.reverse?.challenge?.maxSolveAttempts ?? this.maxChallengeRetries)
                && (existingChallenge?.solved ? this.workflow.reverse?.challenge?.retryOnSolved === true : this.workflow.reverse?.challenge?.retryOnFailed !== false)
              ),
          };

          this._challengeRetryCount.set(url, retryCount + 1);
          response.challenge = challenge;
          response._challengeSolved = challenge.solved && challenge.validated;
          response._challengeType = challenge.type;
          result.reverseChallenge = challenge;
        }

        if (
          this.assetStore
          && this.workflow.signer?.enabled === true
          && this.workflow.signer.capture?.enabled !== false
          && this.workflow.reverse?.assets?.captureSignerFromResponse !== false
        ) {
          const signerAsset = await captureSignerArtifactFromResponse(response, {
            ...this.workflow.signer,
            workflowName: this.workflow.name,
          }, this.assetStore).catch((error) => {
            this._log.debug('signer capture skipped', {
              url,
              error: error?.message ?? String(error),
            });
            return null;
          });
          if (signerAsset) {
            result.signerAsset = signerAsset;
            response.signerAsset = signerAsset;
          }
        }

        return result;
      },
      afterExtract: async (payload) => {
        // Auto-run behavior simulation after page extraction
        if (this.autoBehaviorSim && this.engine.behaviorSim) {
          const page = payload?.response?._page ?? payload?.page ?? null;
          if (page) {
            try {
              await this.engine.simulateHumanBehavior(page);
            } catch (err) {
              this._log.debug('Auto behavior simulation failed', { error: err.message });
            }
          }
        }

        // Auto-run reverse analysis on extracted JS
        if (this.autoReverseAnalysis && this.engine.reverseAnalysis && payload?.result) {
          try {
            const html = payload.result.html ?? payload.result.body ?? payload?.response?.body ?? '';
            if (html) {
              const summary = await this.engine.summarizeWorkflow(html);
              const aiSurface = await this.engine.analyzeAISurface({
                html,
                body: payload.result.body ?? payload?.response?.body ?? html,
                responseBody: payload.result.body ?? payload?.response?.body ?? html,
                status: payload?.response?.status ?? payload?.response?.statusCode ?? 200,
                headers: payload?.response?.headers ?? {},
                target: payload.result.finalUrl ?? payload?.response?.finalUrl ?? payload?.request?.url ?? null,
              });
              payload.result._reverseSummary = summary;
              payload.result._aiSurfaceSummary = aiSurface;
              if (this.assetStore) {
                const aiTarget = aiSurface?.target ?? payload.result.finalUrl ?? payload?.response?.finalUrl ?? payload?.request?.url ?? this.workflow.name ?? 'ai-surface';
                const aiAssetId = `${this.workflow.name ?? 'workflow'}-ai-surface-${aiTarget}`;
                const aiAsset = await this.assetStore.recordAISurface(aiAssetId, aiSurface);
                payload.result._aiSurfaceAsset = {
                  assetId: aiAsset.assetId,
                  versionId: aiAsset.versionId,
                };
              }
            }
          } catch (err) {
            this._log.debug('Auto reverse analysis failed', { error: err.message });
          }
        }
      },
    };
  }

  /**
   * Reset challenge retry counters (call between crawl runs).
   */
  reset() {
    this._challengeRetryCount.clear();
  }
}
