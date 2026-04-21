# 🤝 Contributing to OmniCrawl

First off, thank you for considering contributing to OmniCrawl! It's people like you that make OmniCrawl such a great tool.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [How to Contribute](#how-to-contribute)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Commit Messages](#commit-messages)
- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)

---

## Code of Conduct

This project and everyone participating in it is governed by our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## Getting Started

1. **Fork** the repository on GitHub
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/omnicrawl.git
   cd omnicrawl
   ```
3. **Add upstream** remote:
   ```bash
   git remote add upstream https://github.com/omnicrawl/omnicrawl.git
   ```

## Development Setup

### Prerequisites

- **Node.js** ≥ 20.0.0
- **npm** ≥ 9.0.0
- **Git** ≥ 2.30

### Install Dependencies

```bash
npm install
```

### Run Tests

```bash
# All tests
npm test

# Programmatic API regression suite
npm run test:api

# Reverse module tests
npm run test:reverse

# With coverage
npm run test:coverage
```

### Lint & Format

```bash
# Check linting
npm run lint

# Syntax checks for core runtime
npm run check
```

### Development Mode

```bash
# Watch tests while iterating
npm run test:watch

# Debug a specific module
DEBUG=omnicrawl:* node --inspect your-script.mjs
```

## How to Contribute

### Bug Fixes

1. Find or create an issue describing the bug
2. Comment on the issue that you're working on it
3. Create a branch: `git checkout -b fix/issue-number-description`
4. Write a failing test that demonstrates the bug
5. Fix the bug
6. Ensure all tests pass: `npm test`
7. Submit a Pull Request

### New Features

1. Open a **Feature Request** issue first to discuss the approach
2. Get maintainer approval before investing significant time
3. Create a branch: `git checkout -b feature/issue-number-description`
4. Implement the feature with tests
5. Update documentation if needed
6. Submit a Pull Request

### Documentation

- Fix typos, improve clarity, add examples
- Documentation PRs are always welcome and don't require an issue first
- Create a branch: `git checkout -b docs/description`

## Pull Request Process

1. **Update documentation** — Add or update relevant docs in `docs/`
2. **Add tests** — New features must include tests; bug fixes should include regression tests
3. **Follow coding standards** — Ensure linting passes (`npm run lint`)
4. **One PR per concern** — Keep PRs focused on a single change
5. **Descriptive title** — Use conventional commit format in the PR title
6. **Fill the template** — Complete the PR template with all relevant information
7. **Review** — At least one maintainer must approve before merging

### PR Checklist

- [ ] Tests pass (`npm test`)
- [ ] Linting passes (`npm run lint`)
- [ ] Runtime syntax checks pass (`npm run check`)
- [ ] Documentation updated (if applicable)
- [ ] CHANGELOG.md updated (add entry to "Unreleased" section)
- [ ] No unnecessary files committed
- [ ] Branch is up to date with `main`

## Coding Standards

### JavaScript Style

- **ES Modules** — Use `import`/`export`, not `require()`
- **Async/Await** — Prefer async/await over `.then()` chains
- **Strict equality** — Use `===` and `!==`, never `==` or `!=`
- **Descriptive names** — `requestQueue` not `rq`, `maxConcurrency` not `mc`
- **JSDoc** — Document all public APIs with JSDoc comments
- **Error handling** — Always handle errors; never swallow them silently

### File Organization

```
src/
├── api/           # Public API surface
├── core/          # Core engine internals
├── fetchers/      # HTTP, Browser, WebSocket fetchers
├── middleware/    # Request/response middleware
├── plugins/       # Plugin system
├── reverse/       # Reverse engineering module
├── runtime/       # Runtime services (rate limiter, observability)
├── stores/        # Storage backends
└── utils/         # Shared utilities
```

### Testing

- **Unit tests** — Test individual functions/classes in isolation
- **Integration tests** — Test module interactions
- **Use `node:test`** — We use Node.js built-in test runner
- **Descriptive names** — `should reject requests exceeding bucket capacity with 429`
- **Arrange-Act-Assert** — Follow the AAA pattern
- **No external services** — Mock HTTP calls, don't hit real servers

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, semicolons) |
| `refactor` | Code refactoring (no feature change) |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `chore` | Build, CI, tooling changes |
| `ci` | CI configuration changes |

### Examples

```
feat(rate-limiter): add Redis distributed backend
fix(observability): prevent infinite retry on Pino load failure
docs(api): update RateLimiter token bucket documentation
test(shutdown): add persistence callback ordering tests
chore(deps): update devDependencies
```

## Reporting Bugs

When filing a bug report, please include:

1. **OmniCrawl version** — `npm list omnicrawl`
2. **Node.js version** — `node --version`
3. **OS** — Windows/macOS/Linux + version
4. **Minimal reproduction** — Smallest possible code that demonstrates the issue
5. **Expected behavior** — What you expected to happen
6. **Actual behavior** — What actually happened
7. **Logs** — Relevant log output (use `LOG_LEVEL=debug`)

## Suggesting Features

Feature requests should include:

1. **Use case** — What problem does this solve?
2. **Proposed solution** — How should it work?
3. **Alternatives considered** — What other approaches did you consider?
4. **Examples** — Show how the API would look

---

Thank you for contributing! 🎉
