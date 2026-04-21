export {
  analyzeHtmlForReverse,
  analyzeJavaScript,
  executeReverseSnippet,
  invokeNamedFunction,
} from './reverse-analyzer.js';
export {
  detectJsObfuscationSnippets,
  inferApiParameterStructure,
  inferResponseSchema,
  classifyProtectionSurface,
  analyzeAISurface,
} from './ai-analysis.js';
export { getReverseCapabilitySnapshot, runReverseOperation } from './reverse-capabilities.js';
export {
  solveCaptcha,
  detectCaptcha,
  autoSolveCaptcha,
  injectCaptchaToken,
  getCaptchaBalance,
} from './captcha-solver.js';
export {
  detectCloudflareChallenge,
  solveJsChallenge,
  waitForClearanceCookie,
  handleCloudflareChallenge,
  buildCloudflareStealthHeaders,
} from './cloudflare-solver.js';
export {
  generateMousePath,
  generateTypingEvents,
  generateScrollEvents,
  generateInteractionSequence,
  executeInteractionSequence,
  injectBehaviorSimulation,
  analyzeBehaviorPattern,
} from './behavior-simulation.js';
export {
  locateSignatureFunctions,
  extractFunctionWithDependencies,
  generateRPCWrapper,
  autoSetupSignatureRPC,
  callSignatureRPC,
} from './signature-locator.js';
export {
  getAppWebViewProfile,
  getAvailableWebViewProfiles,
  buildJSBridgeInjection,
  injectAppWebView,
  detectAppWebView,
  createAppScrapeConfig,
} from './app-webview.js';
export {
  analyzeProtobufPayload,
  analyzeGrpcPayload,
  loadProtoSchema,
  decodeProtobufMessage,
  normalizeBinaryInput,
} from './protocol-analyzer.js';
export {
  buildNativeCapturePlan,
  getNativeToolStatus,
} from './native-integration.js';
export {
  analyzeNodeProfile,
  deobfuscateNodeLiterals,
} from './node-runtime-analyzer.js';
