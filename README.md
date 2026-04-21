# NexCrawl 🚀

**The Ultimate Intelligence-Driven Web & App Extraction Framework**

NexCrawl is a high-performance, industrial-grade crawling framework designed to break through the most sophisticated anti-bot protections. It combines Large Language Models (LLM), native mobile automation, and binary protocol reverse engineering into a single, cohesive ecosystem.

[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 🌟 Key Capabilities

### 1. Multi-Mode Extraction Engines
*   **HttpCrawler**: Lightning-fast scraping with HTTP/2 and custom TLS/JA3/JA4 fingerprinting.
*   **BrowserCrawler**: Full DOM rendering via Playwright/Patchright to handle heavy JS and Shadow DOM.
*   **MobileCrawler (Native)**: Direct automation of Android/iOS apps via Appium/Frida, bypassing mobile-specific WAFs.
*   **GrpcCrawler**: Native support for gRPC and Protobuf with automated schema inference.

### 2. AI-Powered Intelligence
*   **AI Semantic Extractor**: Extract structured data (JSON) using natural language schemas. No more brittle XPath or CSS selectors.
*   **AI Task Agent**: Autonomous web agent that observes the page and decides actions (clicks, inputs) to reach a specific goal.

### 3. Advanced Stealth & Anti-Bot
*   **VStealth**: Deep environment masking that wipes `Error.stack` traces and emulates OS-level properties.
*   **Hardware Fingerprinting**: Injects dynamic noise into WebGL, AudioContext, and Canvas to defeat Akamai and DataDome.
*   **MFA Automator**: Built-in support for automated SMS/Email code retrieval during login flows.

### 4. Industrial Scalability
*   **Distributed Sharding**: Scalable task dispatching across Redis clusters for billion-scale URL processing.
*   **Self-Healing Browser Pool**: Real-time monitoring and recycling of browser instances to prevent memory leaks and zombie processes.
*   **Sharded DB Sinks**: High-throughput data storage with automated table partitioning for PostgreSQL/MySQL.

---

## 🚀 Quick Start

### Installation
```bash
npm install nexcrawl
```

### Basic AI Extraction
```javascript
import { NexCrawler, AiExtractor } from 'nexcrawl';

const crawler = new NexCrawler();
const extractor = new AiExtractor();

const html = await crawler.fetch('https://example.com');
const data = await extractor.extract(html, {
  title: "string",
  price: "number",
  stock: "boolean"
});

console.log(data);
```

### Native Mobile Crawling
```javascript
import { MobileCrawler } from 'nexcrawl';

const appCrawler = new MobileCrawler({
  device: { platformName: 'Android', deviceName: 'Pixel_7' }
});

await appCrawler.run();
```

---

## 🛠️ Advanced Reverse Engineering
NexCrawl provides top-tier tools for Node.js internals:
*   **V8 Bytecode Analyzer**: Parse and reverse-engineer `.jsc` (bytenode) files.
*   **Runtime Sentinel**: Transparently audit and intercept `fs`, `crypto`, and `net` calls.
*   **Heap Secrets Finder**: Automated memory forensics to extract session keys directly from process RAM.

---

## 📜 Documentation
Check out our full documentation at [https://github.com/Lyx3314844-03/nexcrawl/docs](https://github.com/Lyx3314844-03/nexcrawl/docs)

## 🤝 Contributing
Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## 📄 License
This project is licensed under the MIT License.
