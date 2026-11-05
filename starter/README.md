# Enterprise Multi-Agent Code Review Orchestrator

Multi-agent pull request reviews using the Claude Agent SDK, GitHub MCP, ESLint MCP, read-only snapshot retrieval, and runtime-validated reports.

## Implemented Workflow

1. A bundled read-only snapshot MCP server fetches the PR, paginated changed files, source tree, and UTF-8 contents at exact head/base commits.
2. The host writes an isolated snapshot under `.reviews/`, with trusted Skills and a trusted ESLint configuration.
3. Claude connects to the configured GitHub/ESLint MCP packages and dispatches three `Task` specialists for quality, static test coverage, and refactoring. All inherit the configured model.
4. The host checks successful specialist completion, report schemas, exact file coverage, and issue line bounds, then recomputes scores and counts.
5. JSON, Markdown, and escaped HTML reports are written under `reports/`. Reports are included in version control; snapshots and credentials are not.

Use Node.js 22.13 or newer. From the repository root:

```bash
npm install
npm run build
npm test
```

Create `starter/.env` from `starter/.env.example`, set an absolute `PROJECT_ROOT` pointing to `starter`, and configure `ANTHROPIC_MODEL`.
Keep preconfigured API credentials in the environment. `.env` overrides existing variables only for keys explicitly present;
an empty `ANTHROPIC_BASE_URL` selects the default endpoint. Never print or commit credentials.

Generate the nine assignment reports:

```bash
cd starter
npm start -- udacity cd14715-simple-todo-app --all
```

Single PR and custom output directory:

```bash
npm start -- udacity cd14715-simple-todo-app 2 --output reports
```

Report names are `udacity_cd14715-simple-todo-app_N.{json,md,html}`. Open HTML files directly in a browser; no server is required.
`npm run dev -- ...` is also supported through `tsx`. The regular test suite uses a mocked SDK with real schema/report processing;
the opt-in live test requires `RUN_LIVE_REVIEW=1`, credentials, model, and project-root variables. Live runs incur API charges.

### Reliability and Limits

- Reviews retry once by default, cancel the SDK after 15 minutes, allow 80 turns, and cap each SDK session at USD 2 (provider billing may vary).
- Failed or missing specialists cause explicit failure, never invented success. Snapshots remain available for diagnosis.
- Coverage is a static estimate, not executed coverage. No repository code, tests, install scripts, plugins, or lint configuration are executed.
- Quality scores start at 100 and subtract 30/15/7/2/0 for critical/high/medium/low/info issues; overall score is the rounded per-file mean.
- The limiter protects host review-job concurrency and rolling request/token reservations. The SDK controls internal model/tool calls;
   this is not a hard per-API-call token cap. Actual reported usage updates the reservation after completion.
- Snapshot limits: 300 changed files, 100 supporting source/test files, 256 KiB per file, and 5 MiB total. Binary files and truncated trees fail explicitly.
- Public GitHub requests work without a token but have a 60/hour limit. Set `GITHUB_TOKEN` for reliable extended runs.
- Tools exclude shell and write access; a permission callback denies tools outside the review allowlist. Prompt-injection guidance and isolated snapshots reduce risk but are not an OS security sandbox.
- The exported GitHub and ESLint configurations use `npx` as required by the rubric. Both packages are installed and locked locally. Snapshot retrieval uses a separate bundled read-only MCP server.
- The rubric-specified `@modelcontextprotocol/server-github` package is archived and unmaintained. This classroom-compatible configuration should not be deployed to production without replacing it with a maintained GitHub MCP server and reviewing dependency advisories.

### Submission Status

The local suite checks schema validation, retry/backoff, timeouts, sliding-window limits, SDK failures,
real MCP subprocess handshakes, and generation of all nine required filenames using mocked agent results
in a temporary directory. These tests are not evidence of completed live Claude analysis.

The live PR analysis was blocked by the configured provider response: "Key access is suspended."
Restore course access or configure a personal Anthropic key locally before running the three required PRs.
No placeholder reports are included as submission deliverables. All nine populated live reports are still required.

## Original Starter Guide

## Project Overview

This system uses multiple specialized AI agents working together to provide comprehensive code reviews:

- **Main Orchestrator** - Coordinates the review process and aggregates results
- **Code Quality Analyzer** - Identifies code smells, anti-patterns, and best practice violations
- **Test Coverage Analyzer** - Evaluates test completeness and suggests missing test cases
- **Refactoring Suggester** - Recommends architectural improvements and refactoring opportunities

## What's Provided

This starter includes the infrastructure you need:

- **Type Definitions** (`src/types/`) - Zod schemas for validation
- **Logger** (`src/utils/logger.ts`) - Winston structured logging
- **Report Generator** (`src/utils/report-generator.ts`) - Markdown/HTML/JSON report generation
- **Project Config** - `package.json`, `tsconfig.json`, `.env.example`
- **Test Skeletons** (`tests/`) - Test file structure
- **Example Skill** (`.claude/skills/`) - Sample Claude skill

## What You Need to Implement

Your tasks:

1. **Agent Definitions** (`src/agents/`)
   - Code Quality Analyzer
   - Test Coverage Analyzer
   - Refactoring Suggester

2. **Prompts** (`src/prompts/`)
   - Orchestrator prompt
   - Agent-specific prompts

3. **MCP Configuration** (`src/config/mcp.config.ts`)
   - GitHub MCP server
   - ESLint MCP server

4. **Orchestrator** (`src/orchestrator.ts`)
   - Main coordination logic
   - Agent spawning and result aggregation

5. **Main Entry Point** (`src/main.ts`)
   - CLI argument parsing
   - Environment validation
   - Report generation

6. **Error Handler** (Recommended) (`src/utils/error-handler.ts`)
   - Custom `ReviewError` class
   - Retry logic with exponential backoff
   - Timeout wrapper

7. **Rate Limiter** (Optional) (`src/utils/rate-limiter.ts`)
   - Token bucket algorithm with sliding window
   - Request and token tracking
   - Concurrent request management

## Getting Started

### Prerequisites

- Node.js 22.13+
- Anthropic API access (provided in Vocareum workspace) or [your own API key](https://console.anthropic.com/)
- [GitHub Personal Access Token](https://github.com/settings/tokens) (recommended - scopes: `repo`, `read:org`)

### Installation

**In Vocareum Workspace (Recommended):**

Your workspace comes pre-configured with Anthropic API credentials.

```bash
# Install dependencies from repository root (uses npm workspaces)
cd /voc/work/cd14715-claude-code-classroom
npm install

# Navigate to project and configure
cd project/starter
cp .env.example .env
```

**Local Setup:**

```bash
# Clone the repository
git clone https://github.com/udacity/cd14715-claude-code-classroom.git
cd cd14715-claude-code-classroom/project/starter

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

### Configuration

Edit `.env` with your settings:

**In Vocareum Workspace:**
```bash
# API credentials are already in your environment - don't add them here

# Model Configuration (REQUIRED)
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

# Project root (REQUIRED)
PROJECT_ROOT=/voc/work/cd14715-claude-code-classroom/project/starter

# GitHub Token (RECOMMENDED for higher rate limits)
# GITHUB_TOKEN=ghp_your-token-here

# Logging level (optional)
LOG_LEVEL=info
```

**Local Setup with Your Own API Key:**
```bash
# Your Anthropic API key
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Model Configuration (REQUIRED)
ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

# Project root (REQUIRED - update to your path)
PROJECT_ROOT=/absolute/path/to/project/starter

# GitHub Token (RECOMMENDED)
# GITHUB_TOKEN=ghp_your-token-here

# Logging level (optional)
LOG_LEVEL=info
```

### Running

```bash
# Development mode
npm run dev -- <owner> <repo> <pr-number>

# Production build
npm run build
npm start <owner> <repo> <pr-number>

# Example
npm run dev -- facebook react 12345
```

### Testing

```bash
# Run all tests
npm test

# Run specific test
npm test -- orchestrator.test.ts

# Watch mode
npm test -- --watch
```

## Key Technologies

- **Claude Agent SDK** - Multi-agent orchestration framework
- **Model Context Protocol (MCP)** - External data integration
- **Zod** - Schema validation and type safety
- **TypeScript** - Type-safe development
- **Vitest** - Testing framework
- **Winston** - Structured logging

## Success Criteria

Your implementation is complete when:

- [ ] TypeScript compiles without errors: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] Can review a real PR: `npm start owner repo pr-number`
- [ ] Generates reports in at least one format (MD, HTML, JSON)
- [ ] Rate limiting prevents API throttling (Optional)
- [ ] Errors are handled gracefully (Recommended)

## Resources

- [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [Anthropic API Docs](https://docs.anthropic.com/)
- [Zod Documentation](https://zod.dev/)

Good luck!