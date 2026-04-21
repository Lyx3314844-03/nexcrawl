<p align="center">
  <img src="logo.svg" width="220" alt="NexCrawl Banner" />
</p>

<h1 align="center">NexCrawl: The Web Intelligence Titan</h1>

<p align="center">
  <b>A comprehensive, AI-first crawling ecosystem for massive data acquisition and advanced reverse engineering.</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Release-v1.2.0-7F00FF?style=for-the-badge" />
  <img src="https://img.shields.io/badge/AI-LLM_Integrated-orange?style=for-the-badge" />
  <img src="https://img.shields.io/badge/Security-Military_Grade-red?style=for-the-badge" />
</p>

---

## 💎 Why NexCrawl?

Most crawlers fail when they hit advanced WAFs (Akamai, DataDome) or require constant maintenance due to UI changes. NexCrawl solves this by moving from **"Rule-Based Extraction"** to **"Intelligence-Driven Extraction."**

### 🎯 Key Performance Pillars

| Feature | Description | Status |
| :--- | :--- | :--- |
| **Zero-Selector AI** | No more XPath/CSS. Describe what you want in plain English. | 🚀 Production |
| **Ghost Stealth** | Hardware-level masking (GPU/Audio) and stack-trace sanitization. | 🛡️ Critical |
| **Native Mobile** | Real-device control with automated SSL Pinning bypass. | 📱 Native |
| **Hyper-Scale** | Distributed sharding for 100M+ URL frontiers. | ⛓️ Scalable |
| **Binary Protocol** | Reverse-engineer gRPC and Protobuf without `.proto` files. | 🛠️ Advanced |

---

## 🛠️ Detailed Capability Map

### 1. 🧠 The Intelligence Layer
NexCrawl integrates a cognitive engine that "understands" the web:
*   **Semantic Data Extraction**: Uses a proprietary **DOM Compression Algorithm** to feed clean, semantic HTML into LLMs (GPT-4/Gemini), extracting structured JSON with 99% accuracy.
*   **Autonomous Agent**: Define a high-level goal (e.g., *"Find the cheapest RTX 4090 on this site and check its delivery time"*). The agent dynamically interacts with elements until the goal is met.
*   **Self-Healing Workflows**: When a website updates its UI, the AI detects the break and automatically repairs the data mapping.

### 2. 🛡️ The Ghost Stealth Stack (Anti-Bot Evasion)
Break through military-grade protection using our multi-layered stealth:
*   **Hardware Entropy Injection**: Injects random noise into **WebGL (GPU)**, **Canvas**, and **AudioContext** fingerprints, ensuring your hardware hash is unique every session.
*   **VStealth Environment**: Wipes all traces of Puppeteer/Playwright from the browser environment, including `Error.stack` sanitization and `Intl` locale consistency.
*   **WAF Fingerprint Spoofing**: Custom HTTP/2 and TLS/JA3/JA4 stacks that perfectly mimic real Chrome/Safari behavior on iOS and Android.

### 3. 📱 Native Mobile & Low-Level Protocols
Go beyond the browser to capture App data:
*   **Frida-Powered Bridge**: Injects hooks into native Android/iOS processes to strip **SSL Pinning** and capture encrypted traffic in plain text.
*   **Protobuf Inferrer**: Automatically discovers the structure of binary gRPC messages, allowing you to scrape high-performance backend APIs directly.
*   **Mobile-Native Router**: Orchestrates Appium sessions like standard web requests, allowing cross-platform scraping flows.

---

## 💻 Installation & Setup

### **Multi-OS Quick Install**

| OS | Command |
| :--- | :--- |
| **Windows** | `npm install -g nexcrawl && npx playwright install chromium` |
| **macOS** | `brew install node && npm install -g nexcrawl` |
| **Linux** | `sudo apt-get install nodejs ffmpeg libnss3 && npm install -g nexcrawl` |

---

## 📖 Advanced Usage Examples

### AI Extraction (No Selectors)
```javascript
import { NexCrawler, AiExtractor } from 'nexcrawl';

const extractor = new AiExtractor({ model: 'gemini-1.5-pro' });
const html = await NexCrawler.fetch('https://some-complex-site.com');

const data = await extractor.extract(html, {
  products: [{ name: "string", discount_price: "number", rating: "number" }]
});
```

### Distributed High-Throughput Job
```javascript
import { ClusterPartitionManager, ShardedDbSink } from 'nexcrawl';

const sink = new ShardedDbSink({ shardType: 'hash', maxBatchSize: 1000 });
const manager = new ClusterPartitionManager({ 
  shards: ['redis://node1', 'redis://node2'] 
});

// Billion-scale URL queue management
await manager.dispatch(myUrls);
```

---

## 📂 Project Structure
```text
nexcrawl/
├── src/
│   ├── api/        # High-level AI & Intelligence interfaces
│   ├── runtime/    # Engines, Sharding, and Storage Sinks
│   ├── reverse/    # WAF Bypass, Frida, and Bytecode Tools
│   └── utils/      # Networking & Crypto utilities
├── docs/           # Deep Technical Documentation
└── tests/          # Industrial-grade Test Suite
```

---

## 📄 License & Commercial
This project is licensed under the **MIT License**. For enterprise support or high-frequency proxy rotation services, contact the maintainers.

## 🌍 Connect
GitHub: [https://github.com/Lyx3314844-03/nexcrawl](https://github.com/Lyx3314844-03/nexcrawl)
