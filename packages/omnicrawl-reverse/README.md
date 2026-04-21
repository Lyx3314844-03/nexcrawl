# omnicrawl-reverse

Reverse-engineering compatibility package for OmniCrawl.

## Status

`omnicrawl-reverse` currently exposes:

- a lightweight standalone subset for static analysis helpers
- a compatibility surface for projects that also install `omnicrawl`

It is not yet a fully independent runtime/browser reverse-engineering package.

## What Works Standalone

- `analyzeHtmlForReverse()`
- `analyzeJavaScript()`
- `detectCloudflareChallenge()`
- `buildCloudflareStealthHeaders()`
- `generateMousePath()`
- `generateTypingEvents()`
- `generateScrollEvents()`
- `generateInteractionSequence()`
- `analyzeBehaviorPattern()`
- `locateSignatureFunctions()`
- `normalizeBinaryInput()`
- `deobfuscateNodeLiterals()`

These helpers are best treated as lightweight inspection utilities, not a full browser/runtime toolkit.

## What Still Requires `omnicrawl`

The following surfaces depend on the main OmniCrawl runtime and will throw without it:

- sandboxed code execution
- browser-coupled CAPTCHA solving and token injection
- Cloudflare runtime challenge handling
- live behavior playback against a browser page
- signature RPC setup and invocation
- app WebView runtime integration
- protobuf / gRPC runtime decoding helpers
- native capture planning
- Node runtime profiling through the main reverse runtime

## Install

```bash
npm install omnicrawl-reverse
```

If you need the full runtime/browser reverse stack, install and import from `omnicrawl` instead.

## Standalone Example

```javascript
import {
  analyzeJavaScript,
  detectCloudflareChallenge,
  locateSignatureFunctions,
} from 'omnicrawl-reverse';

const analysis = await analyzeJavaScript(obfuscatedCode);
const signatures = await locateSignatureFunctions(obfuscatedCode);
const cloudflare = detectCloudflareChallenge(html);
```

## With OmniCrawl

For browser/runtime reverse helpers, prefer the main package:

```javascript
import { OmniCrawler } from 'omnicrawl';

const crawler = new OmniCrawler({ name: 'reverse-aware' })
  .useStealth()
  .useReverseAnalysis();
```

## Export Surface

This package currently publishes the root export only.

Use `omnicrawl` or `omnicrawl/reverse` for the broader, runtime-backed reverse surface.
