# NexCrawl Quick Start

Get up and running with NexCrawl in minutes.

## 1. Installation

Requires **Node.js >= 20.0.0**.

```bash
npm install nexcrawl
```

## 2. Basic Example: AI Data Extraction

NexCrawl allows you to extract data without writing selectors.

```javascript
import { NexHttpCrawler, AiExtractor } from 'nexcrawl';

const crawler = new NexHttpCrawler();
const extractor = new AiExtractor();

const response = await crawler.fetch('https://news.ycombinator.com');
const data = await extractor.extract(response.body, {
  posts: [
    { title: "string", link: "url", points: "number" }
  ]
});

console.log(JSON.stringify(data, null, 2));
```

## 3. High-Stealth Browser Crawling

For websites with anti-bot protection.

```javascript
import { NexBrowserCrawler } from 'nexcrawl';

const crawler = new NexBrowserCrawler({
  browser: {
    engine: 'patchright', // Specialized stealth engine
    headless: true
  },
  stealth: {
    vStealth: true,
    fingerprintNoise: true
  }
});

await crawler.run({
  seedUrls: ['https://example.com']
});
```

## 4. CLI Usage

NexCrawl includes a powerful CLI for running background jobs.

```bash
# Run a predefined workflow
nexcrawl run ./my-job.workflow.json

# Start the interactive dashboard
nexcrawl serve
```

---
For detailed API documentation, see [API_REFERENCE.md](./API_REFERENCE.md).
