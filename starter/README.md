# Enterprise Multi-Agent Code Review Orchestrator

Multi-agent pull request reviews using the Claude Agent SDK, GitHub MCP, ESLint MCP, read-only snapshot retrieval, and runtime-validated reports.

## Implemented Workflow

1. A bundled read-only snapshot MCP server fetches the PR, paginated changed files, source tree, and UTF-8 contents at exact head/base commits.
2. The host writes an isolated snapshot under `.reviews/`, with trusted Skills and a trusted ESLint configuration
   (a curated rule set such as `no-eval` and `eqeqeq` for JavaScript, plus the `typescript-eslint` parser and `@typescript-eslint` rules for TypeScript).
3. Claude connects to the configured GitHub/ESLint MCP packages and dispatches three `Task` specialists for quality, static test coverage, and refactoring. All inherit the configured model.
   Each specialist prompt maps file types to Skills: `security-analysis` for every file, `typescript-patterns` for `.ts/.tsx`,
   `javascript-best-practices` for `.js/.jsx/.mjs/.cjs`, plus `test-analysis` and `refactoring-analysis` for the respective agents.
4. The host records an execution trace of every `Task`, `Skill`, file and MCP tool call, attributed per agent, and shows live progress in the terminal.
5. The host checks successful specialist completion, report schemas, exact file coverage, and issue line bounds, then recomputes scores and counts.
6. JSON, Markdown, and escaped HTML reports are written under `reports/`, including a tool-usage table and a Mermaid sequence diagram of the trace.
   Reports are included in version control; snapshots and credentials are not.

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
The HTML trace diagram is rendered by a pinned, integrity-checked Mermaid script; the Markdown diagram renders natively on GitHub.
`npm run dev -- ...` is also supported through `tsx`. The regular test suite uses a mocked SDK with real schema/report processing;
the opt-in live test requires `RUN_LIVE_REVIEW=1`, credentials, model, and project-root variables. It reviews
`udacity/cd14715-simple-todo-app` PR 1 by default; `LIVE_REVIEW_PR=octocat/Hello-World/1` targets the classic public sample PR.
Live runs incur API charges.

### Additional Features

- **Progress:** in an interactive terminal an ora spinner shows the current tool call with elapsed time, and a
  `PR #2 [##-] 2/3 agents` line is printed as each specialist starts or finishes. When output is piped or in CI
  (no TTY), plain lines are written instead: every tool call, agent start/finish, retries and a
  `... still working, 2m 30s elapsed` heartbeat every 30 seconds, so a slow model never looks like a hung terminal.
  Winston console output is muted while the spinner is active; file logs under `logs/` are unaffected.
- **PR comment:** `npm start -- <owner> <repo> <pr> --post-comment` posts a summary comment through the GitHub MCP `add_issue_comment` tool.
  It requires `GITHUB_TOKEN` with comment permission, fails before any review when the token is missing, and is mocked in tests.
- **Golden regression suite:** `npm run eval [reportsDir]` checks generated reports against known defects of the assignment PRs
  (SQL injection at `src/todo.ts` lines 121/132/143 within 3 lines, untested payment functions in `src/premium.ts`, no critical
  issues in the clean control). `tests/golden.test.ts` runs the same checks over committed reports.

### Reliability and Limits

- Reviews retry transient failures once by default, allow 80 turns, and cap each SDK session at USD 2 (provider billing may vary).
  Each SDK session is cancelled after 30 minutes (`REVIEW_TIMEOUT_MINUTES`, 1-240); a timeout is not retried because
  repeating a slow review would only double its cost.
- Skills are guidance only: every SKILL.md and specialist prompt states that the agent must continue its steps and finish with the
  JSON contract. `tests/skills.test.ts` also rejects `` !` `` in skills, which Claude Code would run as a shell command on load.
- MCP servers get 120 seconds to start (`MCP_TIMEOUT` in milliseconds overrides it). Claude Code's default of 30 seconds is
  shorter than a cold `npx -y @eslint/mcp` start on Windows, which left the ESLint tool silently unavailable.
- The structured-output JSON Schema omits `format` keywords: Claude Code compiles it with strict Ajv and silently drops the
  `StructuredOutput` tool if compilation fails. Zod still validates the full report, including `analyzedAt`, on the host.
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

All nine assignment reports in `reports/` come from live runs (Claude Sonnet 4.5 via the Claude Agent SDK, GitHub MCP for PR data,
ESLint MCP and Claude Skills inside the specialists). Each PR was reviewed with `npm start -- udacity cd14715-simple-todo-app <N>`.

| PR | Changed file | Score | Code-quality findings | Test coverage | Refactorings | Trace events | Duration |
|----|--------------|-------|-----------------------|---------------|--------------|--------------|----------|
| 1 | `fixtures/clean-code.ts` (clean control) | 82 | 2 medium, 2 low, 2 info; no critical/high | no tests, 9 untested paths | 6 | 25 | 12.1 min |
| 2 | `src/todo.ts` | 0 | 3 critical SQL injections at lines 121, 132, 143; 1 high, 7 medium | 15% estimate, 11 untested paths | 6 | 28 | 14.7 min |
| 3 | `src/premium.ts` | 0 | 2 critical, 4 high, 8 medium | no tests, 14 untested paths incl. all 5 payment functions | 7 | 33 | 19.5 min |

`npm run eval` passes 3/3 golden cases on these reports, and `tests/golden.test.ts` repeats the checks in `npm test`.
The local suite also covers schema validation, retry/backoff, timeouts, sliding-window limits, SDK failures, real MCP
subprocess handshakes, and report generation with mocked agent results.

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