<p align="center">
  <img src="logo.svg" width="180" alt="NexCrawl Logo" />
</p>

<h1 align="center">NexCrawl v1.2.0</h1>

<p align="center">
  <strong>The Professional-Grade Web/App Intelligence & Data Extraction Framework</strong>
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen" alt="Node.js" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="License" /></a>
  <img src="https://img.shields.io/badge/AI-Integrated-orange" alt="AI Integrated" />
</p>

---

## 🌟 Top-Tier Capabilities

### 🧠 Intelligence Layer (Zero-Selector)
- **Semantic Extraction**: Powered by LLMs with **DOM Compression**. Feed raw HTML, get structured JSON. No XPath needed.
- **Goal-Oriented Agent**: Give a high-level task (e.g., "Find the latest quarterly report"), and the agent autonomously navigates and collects.

### 🛡️ Ghost Stealth & Anti-Bot
- **Hardware-Level Masking**: Dynamic noise injection for WebGL, AudioContext, and Canvas hashes.
- **VStealth**: Sanitizes execution environments to defeat VM and Headless detection.
- **MFA Automator**: Integrated SMS/Email bridge for automatic multi-factor authentication bypass.

### 📱 Native Mobile & Protocols
- **Native App Crawler**: Integrated Appium support for Android and iOS.
- **Frida Bridge**: Real-time SSL Pinning bypass and native traffic interception.
- **gRPC/Protobuf Engine**: Automated schema inference and binary stream decoding.

### 🚀 Industrial Infrastructure
- **Distributed Sharding**: Redis-based task partitioning for billion-scale URL queues.
- **Self-Healing Pool**: Automated recycling of browser instances based on memory/zombie metrics.
- **Buffered Sharded Storage**: High-throughput database sinks with automatic partitioning.

---

## 💻 Installation Guide

### **1. Windows**
1.  **Node.js**: Install [Node.js v20+](https://nodejs.org/).
2.  **NexCrawl**:
    ```bash
    npm install -g nexcrawl
    ```
3.  **Drivers**:
    ```bash
    npx playwright install chromium
    ```

### **2. macOS**
1.  **Node.js**: `brew install node`
2.  **NexCrawl**:
    ```bash
    npm install nexcrawl
    ```
3.  **Native Tools**: (Optional for Mobile) Install Xcode and `appium`.

### **3. Linux (Ubuntu/Debian)**
1.  **Prerequisites**:
    ```bash
    sudo apt-get update && sudo apt-get install -y nodejs npm ffmpeg libnss3
    ```
2.  **NexCrawl**:
    ```bash
    npm install nexcrawl
    ```

---

## 📖 Quick Start

```javascript
import { NexCrawler, AiExtractor } from 'nexcrawl';

const crawler = new NexCrawler();
const extractor = new AiExtractor();

// Fetch and Extract without selectors!
const response = await crawler.fetch('https://example.com');
const data = await extractor.extract(response.body, {
  title: "string",
  stock_price: "number"
});

console.log(data);
```

---

## 📜 Documentation
- [Architecture & Design](./docs/ARCHITECTURE.md)
- [Advanced Reverse Engineering](./docs/ADVANCED_REVERSE.md)
- [API Reference](./docs/API_REFERENCE.md)

## 🌍 GitHub
[https://github.com/Lyx3314844-03/nexcrawl](https://github.com/Lyx3314844-03/nexcrawl)
