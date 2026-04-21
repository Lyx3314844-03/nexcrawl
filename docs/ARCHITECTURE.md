# OmniCrawl Architecture Overview

> Version 1.1.0 | Current implementation-oriented summary

## High-Level Shape

OmniCrawl currently has four major surfaces:

1. **Programmatic API**
2. **Runtime orchestration**
3. **Fetch / browser / reverse tooling**
4. **Persistence and platform services**

At a high level:

```
OmniCrawler / Presets / Router / CrawlContext
                ↓
            JobRunner
                ↓
   Request Queue / Sessions / Proxy / Policy / Retry
                ↓
 HTTP / Browser / GraphQL / WebSocket fetchers
                ↓
   Dataset / KV / History / Export / Alerts
```

## Core Layers

### 1. Programmatic API (`src/api/`)

Primary user-facing modules:

- `omnicrawler.js`
- `crawler-presets.js`
- `router.js`
- `crawl-context.js`
- `item-pipeline.js`
- `graceful-shutdown.js`

This layer is the fluent builder + handler surface.

### 2. Runtime orchestration (`src/runtime/`)

Key responsibilities:

- workflow execution
- queue/frontier scheduling
- retries and backoff
- session and proxy coordination
- result persistence
- summary/diagnostics generation

Important modules:

- `job-runner.js`
- `request-queue.js`
- `session-store.js`
- `session-pool.js`
- `proxy-pool.js`
- `crawl-policy.js`
- `retry-policy.js`
- `group-backoff.js`
- `workflow-loader.js`

### 3. Fetch / browser / reverse (`src/fetchers/`, `src/reverse/`)

Fetchers:

- `http-fetcher.js`
- `browser-fetcher.js`
- `graphql-fetcher.js`
- `ws-fetcher.js`

Browser support:

- shared browser pool
- page compatibility helpers
- browser debug capture

Reverse / analysis tooling:

- WAF detection / hints
- CAPTCHA helpers
- browser sandbox
- AST / deobfuscation
- signature inference
- reverse diagnostics / replay workflows

This layer is powerful, but not every capability should be interpreted as equally stable by default.

### 4. Persistence / platform

Local and distributed platform services include:

- SQLite-backed stores
- in-repo artifact persistence
- Redis control plane
- distributed worker service
- export and alert outboxes

## Request Lifecycle

Simplified request flow:

1. Workflow is loaded and validated
2. Seeds become queue items
3. `JobRunner` resolves session/proxy/identity/retry state
4. Fetcher executes request
5. Extractors produce structured output
6. Router handler receives `CrawlContext`
7. `pushData()` buffers items
8. `ItemPipeline` optionally transforms them
9. Dataset / KV / summary / exports are persisted

## Observability

Current observability is intentionally best described as:

- **built-in in-process metrics + tracing surface**
- **summary-friendly**
- **lightweight**

It is **not** currently best described as a full external collector/exporter deployment stack.

What exists today:

- internal tracer abstraction
- internal metrics abstraction
- summary generation for runs
- `/metrics` and `/runtime/metrics` HTTP surfaces
- built-in registry wrapper with Prometheus-format output

What should still be treated carefully:

- external collector/exporter assumptions
- full OTEL registry/exporter ecosystem claims
- full prom-client registry semantics

## Logging

Logging is split into:

- `src/core/logger.js` for runtime internals
- `src/utils/logger.js` for exported application-facing usage

Runtime logging now:

- normalizes logger names
- reuses shared pino roots
- redacts sensitive fields

## Key Architecture Risks

The biggest architecture risks now are not “missing all infrastructure”, but:

### 1. Oversized files

Most notable:

- `src/server.js`
- `src/runtime/job-runner.js`
- `src/reverse/reverse-lab-manager.js`

These files still hold too many responsibilities.

### 2. Capability maturity mismatch

Some advanced reverse / anti-bot capabilities are closer to expert tooling than zero-config product surfaces.

### 3. Documentation drift pressure

Because the project exposes many features quickly, docs can drift unless they are regularly reconciled against code.

## Recommended Next Refactor

If continuing architecture work, the best next step is:

1. split `server.js` into route modules + middleware
2. split `job-runner.js` into request assembly / execution / reporting units
3. add module-level tests around those new boundaries
