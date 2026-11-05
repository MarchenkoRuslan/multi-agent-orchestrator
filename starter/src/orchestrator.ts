import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReviewReportSchema, ReviewReportJSONSchema, type ReviewReport } from './types/report-types.js';
import { codeQualityAnalyzer, testCoverageAnalyzer, refactoringSuggester } from './agents/index.js';
import { buildOrchestratorPrompt } from './prompts/index.js';
import { createMcpServersConfig } from './config/mcp.config.js';
import { fetchPullRequestSnapshot, type PullRequestSnapshot } from './mcp/snapshot.js';
import { ErrorCodes, ReviewError, withRetry, withTimeout } from './utils/error-handler.js';
import { RateLimiter, type RateLimiterConfig } from './utils/rate-limiter.js';

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
  queryFn?: typeof query;
  snapshotLoader?: typeof fetchPullRequestSnapshot;
}

export const agents = {
  'code-quality-analyzer': codeQualityAnalyzer,
  'test-coverage-analyzer': testCoverageAnalyzer,
  'refactoring-suggester': refactoringSuggester
};

const allowedTools = ['Task', 'Read', 'Grep', 'Glob', 'Skill', 'mcp__github__get_pull_request',
  'mcp__github__get_pull_request_files', 'mcp__github__get_file_contents', 'mcp__eslint__lint-files'];

export function aggregateReport(report: ReviewReport): ReviewReport {
  const penalties = { critical: 30, high: 15, medium: 7, low: 2, info: 0 };
  for (const review of report.fileReviews) {
    review.codeQuality.overallScore = Math.max(0, 100 - review.codeQuality.issues.reduce((sum, issue) => sum + penalties[issue.severity], 0));
  }
  report.summary = {
    totalFiles: report.fileReviews.length,
    overallScore: report.fileReviews.length ? Math.round(report.fileReviews.reduce((sum, review) => sum + review.codeQuality.overallScore, 0) / report.fileReviews.length) : 0,
    criticalIssues: report.fileReviews.reduce((sum, review) => sum + review.codeQuality.issues.filter(issue => issue.severity === 'critical').length, 0),
    highPriorityTests: report.fileReviews.reduce((sum, review) => sum + review.testCoverage.untestedPaths.filter(path => path.priority === 'critical' || path.priority === 'high').length, 0),
    refactoringOpportunities: report.fileReviews.reduce((sum, review) => sum + review.refactorings.suggestions.length, 0)
  };
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  report.recommendations.sort((first, second) => rank[first.priority] - rank[second.priority]);
  return report;
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
    if (!/^[\w-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || repo === '.' || repo === '..' ||
      !Number.isSafeInteger(prNumber) || prNumber <= 0) {
      throw new ReviewError('Expected a valid GitHub owner, repository, and positive PR number', ErrorCodes.VALIDATION_FAILED);
    }
    const model = this.options.model ?? process.env.ANTHROPIC_MODEL;
    if (!model?.trim()) throw new ReviewError('ANTHROPIC_MODEL is required', ErrorCodes.INVALID_CONFIG);
    const projectRoot = resolve(this.options.projectRoot ?? process.env.PROJECT_ROOT ?? fileURLToPath(new URL('..', import.meta.url)));
    const started = Date.now();
    const snapshot = await withRetry(() => (this.options.snapshotLoader ?? fetchPullRequestSnapshot)(owner, repo, prNumber, projectRoot),
      this.options.maxRetries ?? 1);
    const report = await withRetry(() => this.analyze(owner, repo, prNumber, model, snapshot), this.options.maxRetries ?? 1);
    report.metadata.analyzedAt = new Date().toISOString();
    report.metadata.duration = Date.now() - started;
    return ReviewReportSchema.parse(aggregateReport(report));
  }

  private async analyze(owner: string, repo: string, prNumber: number, model: string, snapshot: PullRequestSnapshot): Promise<ReviewReport> {
    const controller = new AbortController();
    const requestId = await this.rateLimiter.acquire(Math.min(25000, this.options.rateLimits?.maxTokensPerMinute ?? 100000));
    const invoked = new Set<string>();
    const completed = new Set<string>();
    const tasks = new Map<string, string>();
    let actualTokens: number | undefined;
    let stream: ReturnType<typeof query> | undefined;
    try {
      stream = (this.options.queryFn ?? query)({
      prompt: buildOrchestratorPrompt(owner, repo, prNumber, JSON.stringify(snapshot)),
      options: {
        cwd: snapshot.directory,
        model,
        abortController: controller,
        agents,
        mcpServers: createMcpServersConfig(),
        settingSources: ['project'],
        tools: ['Task', 'Read', 'Grep', 'Glob', 'Skill'],
        allowedTools,
        canUseTool: async (name, input) => allowedTools.includes(name) ?
          { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Only read-only review tools are permitted.' },
        disallowedTools: ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'],
        permissionMode: 'default',
        maxTurns: this.options.maxTurns ?? 80,
        maxBudgetUsd: this.options.maxBudgetUsd ?? 2,
        outputFormat: { type: 'json_schema', schema: ReviewReportJSONSchema }
      }
      });
      const session = stream;
      return await withTimeout(async () => {
        for await (const message of session) {
          if (message.type === 'assistant') {
            for (const block of message.message.content) {
              if (block.type === 'tool_use' && block.name === 'Task') {
                const input = block.input as { subagent_type?: string };
                if (input.subagent_type && input.subagent_type in agents) {
                  invoked.add(input.subagent_type);
                  tasks.set(block.id, input.subagent_type);
                }
              }
            }
          }
          if (message.type === 'user' && Array.isArray(message.message.content)) {
            for (const block of message.message.content) {
              if (block.type === 'tool_result' && !block.is_error) {
                const name = tasks.get(block.tool_use_id);
                if (name) completed.add(name);
              }
            }
          }
          if (message.type !== 'result') continue;
          if (message.subtype !== 'success' || message.is_error) {
            let detail = message.subtype === 'success' ? message.result : message.errors.join('; ');
            for (const secret of [process.env.ANTHROPIC_API_KEY, process.env.GITHUB_TOKEN]) {
              if (secret) detail = detail.split(secret).join('[REDACTED]');
            }
            const code = /API Error:\s*(400|401|403|404)\b/.test(detail) ? ErrorCodes.INVALID_CONFIG : ErrorCodes.AGENT_FAILED;
            throw new ReviewError(`Claude review failed (${message.subtype}): ${detail.slice(0, 1500)}`, code);
          }
          actualTokens = message.usage.input_tokens + message.usage.output_tokens;
          if (Object.keys(agents).some(name => !invoked.has(name) || !completed.has(name))) {
            throw new ReviewError('Not all three specialist Tasks completed successfully', ErrorCodes.AGENT_FAILED);
          }
          const parsed = ReviewReportSchema.safeParse(message.structured_output);
          if (!parsed.success) throw new ReviewError('Claude returned an invalid ReviewReport', ErrorCodes.STRUCTURED_OUTPUT_FAILED,
            { validation: parsed.error.flatten() });
          this.validateEvidence(parsed.data, owner, repo, prNumber, snapshot);
          parsed.data.metadata.agentVersions = Object.fromEntries(Object.keys(agents).map(name => [name, '1.0.0']));
          return parsed.data;
        }
        throw new ReviewError('Claude session ended without a structured report', ErrorCodes.STRUCTURED_OUTPUT_FAILED);
      }, this.options.timeoutMs ?? 900000, 'PR analysis timed out; SDK session cancelled');
    } finally {
      controller.abort();
      if (stream) void stream.return(undefined).catch(() => {});
      this.rateLimiter.release(actualTokens, requestId);
    }
  }

  private validateEvidence(report: ReviewReport, owner: string, repo: string, prNumber: number, snapshot: PullRequestSnapshot): void {
    const expected = new Map(snapshot.files.map(file => [file.file, file.lineCount]));
    const seen = new Set<string>();
    if (report.pullRequest.owner !== owner || report.pullRequest.repo !== repo || report.pullRequest.number !== prNumber) {
      throw new ReviewError('Report identifies the wrong pull request', ErrorCodes.STRUCTURED_OUTPUT_FAILED);
    }
    for (const review of report.fileReviews) {
      const maxLine = expected.get(review.file);
      if (!maxLine || seen.has(review.file) || [review.codeQuality.file, review.testCoverage.file, review.refactorings.file].some(file => file !== review.file) ||
        review.codeQuality.issues.some(issue => issue.line > maxLine)) {
        throw new ReviewError(`Invalid or duplicate file evidence: ${review.file}`, ErrorCodes.STRUCTURED_OUTPUT_FAILED);
      }
      seen.add(review.file);
    }
    if (seen.size !== expected.size || report.recommendations.some(rec => rec.files.some(file => !expected.has(file)))) {
      throw new ReviewError('Report omits changed files or references unknown recommendation paths', ErrorCodes.STRUCTURED_OUTPUT_FAILED);
    }
  }
}
