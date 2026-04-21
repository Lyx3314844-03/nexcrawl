# Advanced Reverse Engineering Capabilities

This document details the advanced, production-grade reverse engineering and anti-detection capabilities built into OmniCrawl.

## 1. AI Surface Analysis
The framework includes an AI-driven analysis layer (`src/reverse/ai-analysis.js`) that can:
- **Obfuscation Detection:** Automatically identify common obfuscation tools (e.g., Obfuscator.io, JScrambler).
- **API Parameter Inference:** Guess the purpose and structure of encrypted/encoded request parameters.
- **Protection Classification:** Identify WAFs (Akamai, Cloudflare, Datadome, Kasada) and anti-bot measures from code signals.

## 2. Advanced Fingerprinting (JA3 & JA4)
Beyond standard User-Agent rotation, OmniCrawl provides:
- **TLS Fingerprinting:** Support for both **JA3** and the newer **JA4** standard.
- **HTTP/2 Profiling:** Precise mimicry of browser-specific H2 settings (Window size, Header priority).
- **Identity Parity:** Automatic correction of browser identity drift during sessions.

## 3. App WebView Mimicry
The `app-webview.js` module allows OmniCrawl to pose as a specific mobile application's internal browser.
- **JS Bridge Injection:** Injects mock global objects and methods expected by App-only websites.
- **Native Context Simulation:** Mimics the specific limitations and behaviors of WebViews inside iOS/Android apps.

## 4. Signature RPC Bridge
For sites using complex signing algorithms, OmniCrawl can:
- **Setup RPC:** Turn a local signing function (extracted from the target site) into a remote procedure call service.
- **Runtime Execution:** Execute these functions in a DOM-backed sandbox without needing to port the logic to Node.js.

## 5. Native Toolchain Integration
OmniCrawl integrates with professional security tools:
- **Frida Support:** Automatically generates Frida templates for mobile app function hooking.
- **Mitmproxy Integration:** Orchestrates traffic capture and manipulation via system-level proxies.

## 6. AST-Level Deobfuscation
The `src/reverse/` directory contains tools for static code analysis:
- **Control Flow Flattening Removal:** Restores original logic flow from obfuscated code.
- **String Array Deobfuscation:** Automatically decodes encrypted string pools used in modern JS protection.

## 7. CDP Low-level Debugging
Direct access to the **Chrome DevTools Protocol (CDP)** allows:
- **Script Injection at Source:** Injecting hooks before any other script executes.
- **Memory & Performance Profiling:** Detecting hidden signals used by anti-bots for detection.

## 8. Protobuf & gRPC Inference
OmniCrawl can automatically infer the structure of Protobuf messages from raw binary traffic, enabling the crawling of modern API-driven sites that use binary protocols without having the original `.proto` files.
