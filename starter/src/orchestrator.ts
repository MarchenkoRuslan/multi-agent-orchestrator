import { query, type Options, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewReportSchema, ReviewReportJSONSchema, type ReviewReport } from './types/report-types.js';
import { codeQualityAnalyzer, testCoverageAnalyzer, refactoringSuggester } from './agents/index.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import { createMcpServersConfig } from './config/mcp.config.js';
import { fetchPullRequestSnapshot, type PullRequestSnapshot } from './mcp/snapshot.js';
import { ErrorCodes, ReviewError, formatError, withRetry, withTimeout } from './utils/error-handler.js';
import { ExecutionTracker, type ProgressListener, type ReviewProgressEvent } from './utils/execution-tracker.js';
import { logAgentComplete, logAgentStart, logger, logReviewComplete, logReviewError, logReviewStart } from './utils/logger.js';
import { RateLimiter, type RateLimiterConfig } from './utils/rate-limiter.js';

export type { ReviewProgressEvent, ProgressListener } from './utils/execution-tracker.js';

/**
 * Orchestrator configuration options
 */
export interface OrchestratorOptions {
  model?: string;
  projectRoot?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  rateLimits?: Partial<RateLimiterConfig>;
  /** Receives live progress (snapshot ready, agent started/completed, tool calls, aggregation). */
  onProgress?: ProgressListener;
  queryFn?: typeof query;
  snapshotLoader?: typeof fetchPullRequestSnapshot;
}

export const agents = {
  'code-quality-analyzer': codeQualityAnalyzer,
  'test-coverage-analyzer': testCoverageAnalyzer,
  'refactoring-suggester': refactoringSuggester
};

const AGENT_VERSION = '1.0.0';
const BUILT_IN_TOOLS = ['Task', 'Read', 'Grep', 'Glob', 'Skill'];
/** Read-only tools from the connected GitHub and ESLint MCP servers. */
const MCP_TOOLS = [
  'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_files',
  'mcp__github__get_file_contents',
  'mcp__eslint__lint-files'
];
const allowedTools = [...BUILT_IN_TOOLS, ...MCP_TOOLS];
const DISALLOWED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'];

/** Live Claude reviews through shared proxies can take 10-25 minutes per PR. */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;
/**
 * Claude Code gives each MCP server 30 s to start; `npx -y @eslint/mcp` can take longer on Windows or a busy
 * machine, and the server is then silently unavailable to the agents.
 */
const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TURNS = 80;
const DEFAULT_MAX_BUDGET_USD = 2;
const ESTIMATED_TOKENS_PER_REVIEW = 25_000;
const SEVERITY_PENALTIES = { critical: 30, high: 15, medium: 7, low: 2, info: 0 } as const;
const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

/**
 * Recomputes every score and count from the findings instead of trusting model arithmetic.
 */
export function aggregateReport(report: ReviewReport): ReviewReport {
  for (const review of report.fileReviews) {
    const penalty = sum(review.codeQuality.issues.map(issue => SEVERITY_PENALTIES[issue.severity]));
    review.codeQuality.overallScore = Math.max(0, 100 - penalty);
  }
  const reviews = report.fileReviews;
  report.summary = {
    totalFiles: reviews.length,
    overallScore: reviews.length ? Math.round(sum(reviews.map(review => review.codeQuality.overallScore)) / reviews.length) : 0,
    criticalIssues: sum(reviews.map(review =>
      review.codeQuality.issues.filter(issue => issue.severity === 'critical').length)),
    highPriorityTests: sum(reviews.map(review =>
      review.testCoverage.untestedPaths.filter(path => path.priority === 'critical' || path.priority === 'high').length)),
    refactoringOpportunities: sum(reviews.map(review => review.refactorings.suggestions.length))
  };
  report.recommendations.sort((first, second) => PRIORITY_RANK[first.priority] - PRIORITY_RANK[second.priority]);
  return report;
}

function redactSecrets(text: string): string {
  let redacted = text;
  for (const secret of [process.env.ANTHROPIC_API_KEY, process.env.GITHUB_TOKEN]) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

/** Converts an unsuccessful SDK result into an actionable error; credential/config problems are not retried. */
function sessionFailure(message: SDKResultMessage): ReviewError {
  const detail = redactSecrets(message.subtype === 'success' ? message.result : message.errors.join('; '));
  const code = /API Error:\s*(400|401|403|404)\b/.test(detail) ? ErrorCodes.INVALID_CONFIG : ErrorCodes.AGENT_FAILED;
  return new ReviewError(`Claude review failed (${message.subtype}): ${detail.slice(0, 1500)}`, code);
}

/**
 * Main Code Review Orchestrator
 * Coordinates subagents to analyze pull requests and generate comprehensive reports
 */
export class CodeReviewOrchestrator {
  readonly rateLimiter: RateLimiter;
  private readonly options: OrchestratorOptions;

  constructor(options: OrchestratorOptions = {}) {
    this.options = options;
    this.rateLimiter = new RateLimiter(options.rateLimits);
  }

  /**
   * Review a pull request using parallel subagent analysis
   * @param owner - Repository owner
   * @param repo - Repository name
   * @param prNumber - Pull request number
   * @returns Complete review report
   */
  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<ReviewReport> {
    const validRepository = /^[\w-]+$/.test(owner) && /^[\w.-]+$/.test(repo) && repo !== '.' && repo !== '..';
    if (!validRepository || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new ReviewError('Expected a valid GitHub owner, repository, and positive PR number', ErrorCodes.VALIDATION_FAILED);
    }
    const model = this.options.model ?? process.env.ANTHROPIC_MODEL;
    if (!model?.trim()) throw new ReviewError('ANTHROPIC_MODEL is required', ErrorCodes.INVALID_CONFIG);
    const projectRoot = resolve(this.options.projectRoot ?? process.env.PROJECT_ROOT ??
      fileURLToPath(new URL('..', import.meta.url)));
    const maxRetries = this.options.maxRetries ?? 1;
    const started = Date.now();

    logReviewStart(owner, repo, prNumber);
    try {
      const loadSnapshot = this.options.snapshotLoader ?? fetchPullRequestSnapshot;
      const snapshot = await withRetry(() => loadSnapshot(owner, repo, prNumber, projectRoot), maxRetries);
      this.emitProgress({ type: 'snapshot-ready', files: snapshot.files.length, title: snapshot.title }, snapshot);

      const report = await withRetry(() => this.analyze(owner, repo, prNumber, model, snapshot), maxRetries, 1000, {
        // A whole-session timeout is not transient: retrying would double the wait and the cost.
        shouldRetry: error => !(error instanceof ReviewError && error.code === ErrorCodes.AGENT_TIMEOUT),
        onRetry: (error, attempt) =>
          this.emitProgress({ type: 'retrying', attempt, reason: redactSecrets(formatError(error)).slice(0, 300) }, snapshot)
      });
      report.metadata.analyzedAt = new Date().toISOString();
      report.metadata.duration = Date.now() - started;
      const finalReport = ReviewReportSchema.parse(aggregateReport(report));
      logReviewComplete(owner, repo, prNumber, finalReport.summary.overallScore, finalReport.metadata.duration);
      return finalReport;
    } catch (error) {
      logReviewError(owner, repo, prNumber, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private emitProgress(event: ReviewProgressEvent, snapshot: PullRequestSnapshot): void {
    const scope = `${snapshot.files.length} changed file(s)`;
    if (event.type === 'agent-started') logAgentStart(event.agent, scope);
    else if (event.type === 'agent-completed') logAgentComplete(event.agent, scope, event.durationMs, event.success);
    else if (event.type === 'tool-call') logger.debug('Tool call', { actor: event.actor, target: event.target, tool: event.label });
    else if (event.type === 'retrying') logger.warn('Retrying PR analysis', { attempt: event.attempt, reason: event.reason });
    this.options.onProgress?.(event);
  }

  private buildQueryOptions(model: string, snapshot: PullRequestSnapshot, abortController: AbortController): Options {
    return {
      cwd: snapshot.directory,
      model,
      abortController,
      agents,
      mcpServers: createMcpServersConfig(),
      env: { ...process.env, MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? String(DEFAULT_MCP_STARTUP_TIMEOUT_MS) },
      settingSources: ['project'],
      tools: BUILT_IN_TOOLS,
      allowedTools,
      canUseTool: async (name, input) => allowedTools.includes(name)
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Only read-only review tools are permitted.' },
      disallowedTools: DISALLOWED_TOOLS,
      permissionMode: 'default',
      maxTurns: this.options.maxTurns ?? DEFAULT_MAX_TURNS,
      maxBudgetUsd: this.options.maxBudgetUsd ?? DEFAULT_MAX_BUDGET_USD,
      outputFormat: { type: 'json_schema', schema: ReviewReportJSONSchema }
    };
  }

  private async analyze(
    owner: string,
    repo: string,
    prNumber: number,
    model: string,
    snapshot: PullRequestSnapshot
  ): Promise<ReviewReport> {
    const controller = new AbortController();
    const estimatedTokens = Math.min(ESTIMATED_TOKENS_PER_REVIEW, this.options.rateLimits?.maxTokensPerMinute ?? 100_000);
    const requestId = await this.rateLimiter.acquire(estimatedTokens);
    const tracker = new ExecutionTracker(Object.keys(agents), event => this.emitProgress(event, snapshot));
    const usage: { tokens?: number } = {};
    let stream: ReturnType<typeof query> | undefined;
    try {
      stream = (this.options.queryFn ?? query)({
        prompt: buildOrchestratorPrompt(owner, repo, prNumber, JSON.stringify(snapshot)),
        options: this.buildQueryOptions(model, snapshot, controller)
      });
      const session = stream;
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return await withTimeout(
        () => this.consumeSession(session, tracker, usage, { owner, repo, number: prNumber }, snapshot),
        timeoutMs,
        `PR analysis timed out after ${Math.round(timeoutMs / 60_000)} minute(s); SDK session cancelled. ` +
          'Set REVIEW_TIMEOUT_MINUTES to allow longer reviews.'
      );
    } finally {
      controller.abort();
      if (stream) void stream.return(undefined).catch(() => {});
      this.rateLimiter.release(usage.tokens, requestId);
    }
  }

  private async consumeSession(
    session: AsyncIterable<SDKMessage>,
    tracker: ExecutionTracker,
    usage: { tokens?: number },
    pullRequest: ReviewReport['pullRequest'],
    snapshot: PullRequestSnapshot
  ): Promise<ReviewReport> {
    for await (const message of session) {
      tracker.handle(message);
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error) throw sessionFailure(message);
      usage.tokens = message.usage.input_tokens + message.usage.output_tokens;

      const missing = tracker.missingAgents();
      if (missing.length) {
        throw new ReviewError(`Specialist Tasks did not complete successfully: ${missing.join(', ')}`, ErrorCodes.AGENT_FAILED);
      }
      this.emitProgress({ type: 'aggregating' }, snapshot);
      const parsed = ReviewReportSchema.safeParse(message.structured_output);
      if (!parsed.success) {
        throw new ReviewError('Claude returned an invalid ReviewReport', ErrorCodes.STRUCTURED_OUTPUT_FAILED,
          { validation: parsed.error.flatten() });
      }
      this.validateEvidence(parsed.data, pullRequest, snapshot);
      parsed.data.metadata.agentVersions = Object.fromEntries(Object.keys(agents).map(name => [name, AGENT_VERSION]));
      parsed.data.metadata.executionTrace = tracker.trace;
      return parsed.data;
    }
    throw new ReviewError('Claude session ended without a structured report', ErrorCodes.STRUCTURED_OUTPUT_FAILED);
  }

  /** Ensures the report covers exactly the changed files of the requested PR with in-range line evidence. */
  private validateEvidence(report: ReviewReport, expectedPr: ReviewReport['pullRequest'], snapshot: PullRequestSnapshot): void {
    const { owner, repo, number } = report.pullRequest;
    if (owner !== expectedPr.owner || repo !== expectedPr.repo || number !== expectedPr.number) {
      throw new ReviewError('Report identifies the wrong pull request', ErrorCodes.STRUCTURED_OUTPUT_FAILED);
    }
    const lineCounts = new Map(snapshot.files.map(file => [file.file, file.lineCount]));
    const seen = new Set<string>();
    for (const review of report.fileReviews) {
      const maxLine = lineCounts.get(review.file);
      const sectionFiles = [review.codeQuality.file, review.testCoverage.file, review.refactorings.file];
      const invalid = !maxLine || seen.has(review.file) || sectionFiles.some(file => file !== review.file) ||
        review.codeQuality.issues.some(issue => issue.line > maxLine);
      if (invalid) throw new ReviewError(`Invalid or duplicate file evidence: ${review.file}`, ErrorCodes.STRUCTURED_OUTPUT_FAILED);
      seen.add(review.file);
    }
    const unknownPaths = report.recommendations.some(rec => rec.files.some(file => !lineCounts.has(file)));
    if (seen.size !== lineCounts.size || unknownPaths) {
      throw new ReviewError('Report omits changed files or references unknown recommendation paths',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED);
    }
  }
}
