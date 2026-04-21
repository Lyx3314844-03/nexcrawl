import { interpolateReplayValue } from '../utils/replay-template.js';
import { getGlobalConfig } from '../utils/config.js';

/**
 * 负责构造和校验作业请求输入
 */
export class JobInputBuilder {
  constructor(workflow) {
    this.workflow = workflow;
    this.globalConfig = getGlobalConfig();
  }

  build(item, { proxy, session } = {}) {
    const replayState = item.replayState ?? null;
    const workflowRequest = this.workflow.request ?? {};
    const effectiveIdentity = this._mergeIdentityConfig(this.workflow.identity ?? null, session?._boundIdentityProfile ?? null);
    
    const request = {
      url: this._resolveValue(item.url, replayState),
      method: String(this._resolveValue(item.method ?? workflowRequest.method ?? 'GET', replayState)).toUpperCase(),
      headers: {
        ...this._buildIdentityHeaders(effectiveIdentity ?? {}),
        ...(this._resolveValue(this.workflow.headers ?? {}, replayState) ?? {}),
        ...(this._resolveValue(item.headers ?? {}, replayState) ?? {}),
      },
      body: this._resolveValue(item.body ?? workflowRequest.body, replayState),
      timeoutMs: this.workflow.timeoutMs ?? this.globalConfig.get('performance.timeout'),
      proxy,
      session,
      identity: effectiveIdentity,
      replayState,
    };

    return this._enforceConsistency(request);
  }

  _resolveValue(value, replayState, { strict = true } = {}) {
    if (value === undefined) return undefined;
    if (!replayState) return value;
    return interpolateReplayValue(value, replayState, { strict });
  }

  _mergeIdentityConfig(base, override) {
    if (!base && !override) return null;
    return {
      ...(base ?? {}),
      ...(override ?? {}),
      enabled: (override?.enabled ?? base?.enabled) !== false,
    };
  }

  _buildIdentityHeaders(identity) {
    return {
      'user-agent': identity.userAgent,
      'accept-language': identity.acceptLanguage || identity.locale,
    };
  }

  _enforceConsistency(request) {
    // 补齐点：在此处实现更严格的指纹校验，防止 Headers 与 TLS 指纹不匹配
    return request;
  }
}
