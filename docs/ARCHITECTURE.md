# NexCrawl Deep Architecture

NexCrawl is designed as a modular, high-reliability platform for intelligence-driven data acquisition.

## 1. System Topology

### 1.1 The Intelligence Engine (Cognitive Layer)
- **AI Extractor v2**: Features DOM Semantic Compression. It strips 90% of redundant HTML noise before sending to LLM, reducing latency and costs.
- **Goal-Oriented AI Agent**: Uses a Recursive Task Decomposition (RTD) algorithm to break down complex user goals into atomic browser/app actions.

### 1.2 Multi-Dimensional Fetchers (Execution Layer)
- **HttpFetcher**: Custom TLS Stack + JA3/JA4 fingerprinting.
- **Mobile Native Driver**: Integrated with Appium for UI control and Frida for SSL Pinning/Root check bypass.
- **gRPC/Proto Streamer**: High-performance HTTP/2 transport with real-time binary-to-JSON decoding.

### 1.3 The Ghost Stealth Stack (Defense Layer)
- **Virtualization Masking**: Sanitizes JavaScript execution contexts to hide automation traces (Error stacks, property enumeration).
- **Entropy Injection**: Injects low-level noise into Canvas, WebGL, and Audio hardware outputs to defeat device fingerprinting.

## 2. Scalability Model
- **Queue Sharding**: MD5-based URL partitioning across Redis clusters.
- **Buffered Storage**: `ShardedDbSink` implements a thread-safe write buffer with automatic interval flushing to prevent database deadlocks under high load.

---
© 2026 NexCrawl Lab.
