# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-04-01

### Added - Phase 1: Usable Framework

- **CheerioFetcher**: Lightweight HTML parsing crawler using cheerio, equivalent to Crawlee's CheerioCrawler. Fast static-content crawling without browser overhead.
- **DomainRateLimiter**: Per-domain rate limiting with token-bucket burst support, configurable RPS, jitter, and domain-specific overrides.
- **ExportManager**: Multi-format data export supporting CSV, JSON, JSONL, and pluggable database sinks. Equivalent to Scrapy's Feed Exports.
- **RequestFingerprint**: URL normalization and request deduplication algorithm. Normalizes query parameter order, removes tracking params, and computes SHA-256 fingerprints.
- **TypeScript support**: Added `tsconfig.json` and comprehensive type declarations (`src/types/index.d.ts`) for JSDoc-based type checking without full TS migration.
- **npm publishing preparation**: Updated `package.json` with proper keywords, repository, homepage, and files fields.

### Added - Phase 2: Mature Framework

- **Docker containerization**: Multi-stage Dockerfile with Chromium pre-installed, non-root user, health check, and Prometheus metrics port.
- **CI/CD GitHub Actions**: Automated lint, syntax check, unit tests (Node 20 + 22), Docker build test, and npm publish on tag.
- **Proxy provider integrations**: Adapters for Bright Data, Smartproxy, Oxylabs, and custom HTTP API proxy providers with country targeting and session stickiness.
- **JSDoc documentation**: Comprehensive JSDoc annotations across all new modules for API documentation generation.

### Added - Phase 3: Top-Tier Framework

- **Observability**: OpenTelemetry-compatible tracing (SimpleTracer) and Prometheus metrics (MetricsCollector) with `/metrics` endpoint.
- **Performance benchmarks**: BenchmarkRunner for measuring throughput, latency (P50/P95/P99), and RPS across crawl modes.
- **Plugin ecosystem**: PluginRegistry for community plugins, NPM-based discovery, and built-in community plugins (sitemap, JSON-LD, robots-meta).
- **CHANGELOG.md**: This file, following Keep a Changelog format.

### Changed

- OmniCrawler now supports `mode: 'cheerio'` for lightweight HTML parsing.
- Updated `index.js` to export all new modules.

## [1.0.0] - 2026-03-28

### Added

- Initial release of OmniCrawl.
- OmniCrawler class with fluent API (builder pattern).
- HTTP fetcher with TLS fingerprinting (JA3/JA4) and proxy tunneling.
- Browser fetcher with Puppeteer integration and browser pool management.
- JobRunner with distributed SQLite/Redis backends.
- CrawlPolicyManager with robots.txt parsing and sitemap seeding.
- AutoscaleController for adaptive concurrency.
- Full reverse engineering suite: AST analyzer, webpack extractor, Cloudflare solver, CAPTCHA solver.
- Stealth profile with canvas/audio/font noise injection.
- Express API server with event streaming.
- Plugin and middleware system.

[1.1.0]: https://github.com/Lyx3314844-03/omnicrawl/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Lyx3314844-03/omnicrawl/releases/tag/v1.0.0
