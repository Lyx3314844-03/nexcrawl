# NexCrawl Architecture

NexCrawl is built as a layered, modular framework designed for high-concurrency data acquisition and advanced reverse engineering.

## 1. System Layers

### 1.1 Interface Layer (Programmatic & CLI)
- **NexCrawler (Unified API)**: The main entry point for all crawling activities.
- **Router**: Middleware-based routing for handling different URL patterns.
- **CLI**: Advanced command-line interface for running workflows and managing jobs.

### 1.2 Intelligence Layer (New 🚀)
- **AI Extractor**: Leverages LLMs to understand DOM structures and extract data without manually defined rules.
- **AI Task Agent**: Autonomous decision-making engine for navigating complex SPA or App interfaces.

### 1.3 Engine Layer (Multi-Mode)
- **HttpFetcher**: High-performance HTTP/2 client with customizable TLS/JA3 fingerprints.
- **BrowserFetcher**: Playwright/Patchright integration for JS-heavy sites.
- **MobileFetcher**: Native App automation via Appium/Frida.
- **GrpcFetcher**: Binary protocol reverse engineering and decoding.

### 1.4 Stealth Layer (The "Ghost" Layer)
- **VStealth**: Removes automation traces from Error stacks and emulates real OS environment properties.
- **Fingerprint Protection**: Dynamic noise injection in Canvas, WebGL, and AudioContext.
- **WAF Bypass**: Built-in logic for Cloudflare, Akamai, and DataDome.

### 1.5 Infrastructure Layer
- **Cluster Partitioning**: MD5-based task sharding across Redis clusters.
- **Sharded DB Sinks**: High-performance SQL storage with automated table partitioning.
- **Browser Pool Guard**: Self-healing monitoring for browser instance health.

## 2. Data Flow

1.  **Workflow Loading**: Loads job definitions from JSON or JS.
2.  **Task Dispatching**: `ClusterPartitionManager` assigns URLs to available workers.
3.  **Engine Execution**: Selected engine fetches data while `VStealth` masks the session.
4.  **Intelligence Extraction**: `AiExtractor` transforms raw content into structured JSON.
5.  **Data Persistence**: `ShardedDbSink` streams validated data to partitioned storage.

---
© 2026 NexCrawl Team.
