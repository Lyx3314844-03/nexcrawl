<p align="center">
  <img src="logo.svg" width="220" alt="NexCrawl Banner" />
</p>

<h1 align="center">NexCrawl: The Infinite Intelligence Platform</h1>

<p align="center">
  <b>The world's most comprehensive framework for Web, App, and API data extraction.</b><br>
  Built for industrial-scale intelligence, military-grade stealth, and zero-maintenance AI automation.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.2.0-blueviolet?style=for-the-badge" />
  <img src="https://img.shields.io/badge/AI-Autonomous_Agents-orange?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Anti--Bot-WAF_Slayer-red?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Mobile-Native_Interception-green?style=for-the-badge" />
</p>

---

## 🌌 The Periodic Table of NexCrawl Capabilities

### 1. 🧠 Intelligence Layer (The Brain)
*   **Zero-Selector Extraction**: Direct HTML-to-JSON reasoning using LLMs (GPT/Gemini).
*   **Semantic DOM Compression**: Proprietary algorithm to strip 90% of HTML noise for cost-efficient AI processing.
*   **Autonomous Task Agent**: Goal-driven navigation (Recursive Task Decomposition) to handle complex interactions.
*   **Self-Healing Pipelines**: Automatically detects and repairs extraction rules when a site's UI changes.
*   **MFA Automator**: Built-in logic to intercept and auto-fill SMS/Email verification codes.

### 2. 🛡️ Ghost Stealth Stack (The Cloak)
*   **VStealth Runtime**: Deep sanitization of the JS environment to wipe all traces of Playwright/Puppeteer/Selenium.
*   **Hardware Entropy Injection**: Dynamic noise injection for **WebGL**, **Canvas**, and **AudioContext** fingerprints.
*   **TLS/JA3/JA4 Spoofing**: Fully customizable TLS handshake signatures to mimic any modern browser or mobile device.
*   **HTTP/2 Frame Fingerprinting**: Precise control over H2 settings, windows, and stream priorities to defeat server-side OS fingerprinting.
*   **Intl/Locale Consistency**: Synchronizes browser timezone, language, and hardware concurrency with proxy IP location.

### 3. 📱 Mobile & Native Lab (The Bridge)
*   **Native App Crawler**: Direct automation of Android and iOS apps via Appium integration.
*   **Frida Bridge**: Real-time native Hooking to bypass **SSL Pinning**, Root checks, and emulator detection.
*   **WebView Interceptor**: Seamlessly transition between Native App contexts and embedded WebViews.
*   **Binary Protocol Inferrer**: Automatically reconstructs Protobuf schemas from raw gRPC/HTTP2 streams.
*   **Native App Routing**: Orchestrates mobile app flows using the same middleware-based Router as web crawls.

### 4. 🛠️ Reverse Engineering Toolkit (The X-Ray)
*   **V8 Bytecode Analyzer**: Static and dynamic analysis of compiled `.jsc` (bytenode) files.
*   **Heap Memory Forensics**: Automated RAM scanning to extract dynamic encryption keys and session tokens.
*   **Runtime Sentinel**: Transparent monitoring of Node.js system calls (`fs`, `net`, `crypto`).
*   **Control Flow Deobfuscator**: Built-in tools for unwinding complex JS obfuscation and string-array encoding.
*   **WASM Reversing**: Extraction and analysis of WebAssembly modules used in modern signature generation.

### 5. ⛓️ Industrial Ops & Scaling (The Exoskeleton)
*   **Queue Sharding**: MD5-based URL partitioning across Redis clusters for billion-scale task management.
*   **Sharded DB Sinks**: High-throughput storage with automated table partitioning for PostgreSQL, MySQL, and Mongo.
*   **Browser Pool Guard**: Self-healing service that monitors instance health and recycles leaky or zombie processes.
*   **Predictive Autoscaling**: Adjusts concurrency in real-time based on system load and target site pressure.
*   **Data Integrity Guard**: Integrated Zod-based validation pipelines to block "dirty data" from entering the database.

### 6. 📡 Multi-Mode Engines (The Heart)
*   **HttpCrawler**: Lightning-fast, stateless fetcher for high-speed API and HTML scraping.
*   **BrowserCrawler**: Full-render engine for heavy SPA, Shadow DOM, and Canvas-based sites.
*   **GrpcCrawler**: Native transport for binary gRPC services with auto-decoding.
*   **TorCrawler**: Built-in anonymity circuits for dark-web (.onion) access and IP rotation.
*   **WebSocket/GraphQL**: Native support for modern real-time and query-based protocols.
*   **StreamRecorder**: Live-stream capturing (RTMP/HLS) with automated segmenting via FFmpeg.

---

## 💻 Installation Matrix

| Operating System | Quick Install Command | Requirements |
| :--- | :--- | :--- |
| **Windows** | `npm install -g nexcrawl && npx playwright install` | Node.js v20+ |
| **macOS** | `brew install node && npm install -g nexcrawl` | Homebrew |
| **Linux** | `sudo apt install nodejs ffmpeg libnss3 && npm install -g nexcrawl` | Ubuntu/Debian |

---

## 🚀 The NexCrawl Workflow

```javascript
import { NexCrawler, AiExtractor, NativeBridge, ShardedDbSink } from 'nexcrawl';

// 1. Initialize professional-grade components
const crawler = new NexCrawler({ stealth: { vStealth: true } });
const extractor = new AiExtractor();
const sink = new ShardedDbSink({ shardType: 'daily' });

// 2. Perform intelligence-driven extraction
const response = await crawler.fetch('https://complex-target.com');
const data = await extractor.extract(response.body, {
  market_trends: [{ topic: "string", sentiment: "number" }]
});

// 3. Stream to high-scale storage
await sink.push(data);
```

---

## 📄 Licensing & Ecosystem
*   **License**: MIT
*   **Full Documentation**: [./docs](./docs)
*   **API Reference**: [./docs/API_REFERENCE.md](./docs/API_REFERENCE.md)
*   **Industrial Guide**: [./docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)

---

## 🌍 Connect with NexCrawl
GitHub: [https://github.com/Lyx3314844-03/nexcrawl](https://github.com/Lyx3314844-03/nexcrawl)
Issues: [Submit a Bug Report](https://github.com/Lyx3314844-03/nexcrawl/issues)
