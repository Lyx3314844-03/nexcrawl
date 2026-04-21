# NexCrawl API Reference

## 1. Crawlers

### NexHttpCrawler
Lightweight, high-speed crawler based on undici/fetch.
- `fetch(url, options)`: Returns response metadata and body.
- `run(workflow)`: Executes a full crawling job.

### NexBrowserCrawler
Full-browser crawler powered by Playwright/Patchright.
- `context`: Direct access to Playwright BrowserContext.
- `page`: Current active page instance.

### MobileCrawler (Native)
Drives physical devices or emulators via Appium.
- `deviceConfig`: Defines platformName, deviceName, etc.
- `run()`: Starts the native session.

### GrpcCrawler
Handles binary Protobuf streams.
- `request(service, method, payload)`: Unary RPC.
- `serverStream(service, method, payload)`: Server-side streaming.

## 2. Intelligence

### AiExtractor
- `extract(html, schema)`: Uses LLM to parse HTML into structured data.

### AiAgent
- `execute(goal)`: Autonomous goal-driven interaction.

## 3. Storage & Sinks

### ShardedDbSink
- `shardType`: 'daily' or 'hash'.
- `push(item)`: Automatically routes data to the correct partition.

## 4. Advanced Stealth

### VStealth
- `buildHardenedEnvironmentInjection()`: Returns a JS snippet to mask Error.stack and environment traces.

### NativeBridge (Frida)
- `inject(bundleId)`: Hooks native processes to bypass SSL Pinning.

---
© 2026 NexCrawl.
