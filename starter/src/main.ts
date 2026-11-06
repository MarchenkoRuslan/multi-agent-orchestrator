import * as dotenv from 'dotenv';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { agents, CodeReviewOrchestrator } from './orchestrator.js';
import { postReviewComment } from './mcp/pr-commenter.js';
import type { ReviewReport } from './types/report-types.js';
import { ErrorCodes, ReviewError, formatError } from './utils/error-handler.js';
import { ReviewProgress } from './utils/progress.js';
import { ReportGenerator } from './utils/report-generator.js';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));

/** Assignment PRs reviewed by `--all`. */
const ASSIGNMENT_PRS = [1, 2, 3];
const OWNER_PATTERN = /^[\w-]+$/;
const REPO_PATTERN = /^[\w.-]+$/;
const PR_NUMBER_PATTERN = /^[1-9]\d*$/;

const USAGE = [
  'Usage: npm start -- <owner> <repo> <pr-number> [--output <directory>] [--post-comment]',
  '       npm start -- <owner> <repo> --all [--output <directory>] [--post-comment]'
].join('\n');

const HELP = `${USAGE}

Options:
  --all            Review PRs 1, 2 and 3 of the repository (assignment mode)
  --output <dir>   Report directory (default: <PROJECT_ROOT>/reports)
  --post-comment   Also post the review summary as a PR comment via the GitHub MCP server (needs GITHUB_TOKEN)
  -h, --help       Show this help

Example: npm start -- udacity cd14715-simple-todo-app 2
Writes <owner>_<repo>_<pr>.json, .md and .html for every reviewed PR.`;

export type CliArgs =
  | { help: true }
  | { help: false; owner: string; repo: string; numbers: number[]; output?: string; postComment: boolean };

const usageError = (problem: string): ReviewError =>
  new ReviewError(`${problem}\n${USAGE}`, ErrorCodes.VALIDATION_FAILED);

/**
 * Parses and validates `<owner> <repo> <pr-number>` (or `<owner> <repo> --all`) from process.argv.
 */
export function parseCliArgs(args: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        all: { type: 'boolean', default: false },
        output: { type: 'string' },
        'post-comment': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' }
      }
    });
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }
  const { positionals, values } = parsed;
  if (values.help) return { help: true };

  const [owner, repo, prNumber] = positionals;
  const expectedArguments = values.all ? 2 : 3;
  if (positionals.length !== expectedArguments) {
    throw usageError(values.all
      ? 'With --all, pass only <owner> and <repo>.'
      : 'Expected exactly three arguments: <owner> <repo> <pr-number>.');
  }
  if (!owner || !OWNER_PATTERN.test(owner)) {
    throw usageError(`Invalid repository owner "${owner}": use letters, digits, "-" or "_".`);
  }
  if (!repo || !REPO_PATTERN.test(repo) || repo === '.' || repo === '..') {
    throw usageError(`Invalid repository name "${repo}": use letters, digits, ".", "-" or "_".`);
  }
  const common = { help: false as const, owner, repo, output: values.output, postComment: values['post-comment'] };
  if (values.all) return { ...common, numbers: ASSIGNMENT_PRS };

  if (!prNumber || !PR_NUMBER_PATTERN.test(prNumber) || !Number.isSafeInteger(Number(prNumber))) {
    throw usageError(`PR number must be a positive integer, got "${prNumber}".`);
  }
  return { ...common, numbers: [Number(prNumber)] };
}

function validateEndpoint(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ReviewError('ANTHROPIC_BASE_URL must be a valid URL', ErrorCodes.INVALID_CONFIG);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new ReviewError('Invalid API endpoint URL', ErrorCodes.INVALID_CONFIG);
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new ReviewError('Remote API endpoints must use HTTPS', ErrorCodes.INVALID_CONFIG);
  }
}

/**
 * Validates required configuration on startup: Claude credentials (API key or Bedrock), model and project root.
 */
export async function validateEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const bedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  if (bedrock) {
    const hasAwsCredentials = Boolean(env.AWS_PROFILE) || Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);
    if (!env.AWS_REGION || !hasAwsCredentials) {
      throw new ReviewError('Bedrock requires AWS_REGION and AWS_PROFILE or AWS access-key credentials', ErrorCodes.INVALID_CONFIG);
    }
  } else if (!env.ANTHROPIC_API_KEY?.trim()) {
    throw new ReviewError('Set ANTHROPIC_API_KEY in your environment or starter/.env, ' +
      'or configure CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials', ErrorCodes.MISSING_API_KEY);
  }
  if (!env.ANTHROPIC_MODEL?.trim()) {
    throw new ReviewError('ANTHROPIC_MODEL environment variable is required', ErrorCodes.INVALID_CONFIG);
  }
  if (!env.PROJECT_ROOT || !isAbsolute(env.PROJECT_ROOT)) {
    throw new ReviewError('PROJECT_ROOT must be an absolute path to project/starter', ErrorCodes.INVALID_CONFIG);
  }
  if (env.ANTHROPIC_BASE_URL) validateEndpoint(env.ANTHROPIC_BASE_URL);
  try {
    await access(join(env.PROJECT_ROOT, '.claude', 'skills'));
  } catch {
    throw new ReviewError('PROJECT_ROOT must contain .claude/skills; build and run from project/starter', ErrorCodes.INVALID_CONFIG);
  }
  return { projectRoot: resolve(env.PROJECT_ROOT), model: env.ANTHROPIC_MODEL, bedrock, timeoutMs: parseTimeout(env.REVIEW_TIMEOUT_MINUTES) };
}

/** Optional REVIEW_TIMEOUT_MINUTES override of the per-PR analysis timeout (1-240 minutes). */
function parseTimeout(minutes: string | undefined): number | undefined {
  if (!minutes?.trim()) return undefined;
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 1 || value > 240) {
    throw new ReviewError(`REVIEW_TIMEOUT_MINUTES must be a number between 1 and 240, got "${minutes}"`, ErrorCodes.INVALID_CONFIG);
  }
  return Math.round(value * 60_000);
}

/** Writes JSON, Markdown and HTML reports atomically (temp file + rename). */
async function writeReports(output: string, stem: string, generator: ReportGenerator, report: ReviewReport): Promise<void> {
  const contents = {
    json: generator.generateJSONReport(report),
    md: generator.generateMarkdownReport(report),
    html: generator.generateHTMLReport(report)
  };
  for (const [extension, content] of Object.entries(contents)) {
    const target = join(output, `${stem}.${extension}`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, content, 'utf8');
    await rename(temporary, target);
  }
}

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm start -- <owner> <repo> <pr-number>
 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const cli = parseCliArgs(args);
  if (cli.help) {
    console.log(HELP);
    return;
  }
  dotenv.config({ path: join(defaultRoot, '.env'), override: true });
  if (process.env.ANTHROPIC_BASE_URL === '') delete process.env.ANTHROPIC_BASE_URL;
  const config = await validateEnvironment();
  if (cli.postComment && !process.env.GITHUB_TOKEN?.trim()) {
    throw new ReviewError('--post-comment requires GITHUB_TOKEN with permission to comment on the repository',
      ErrorCodes.MISSING_GITHUB_TOKEN);
  }
  console.log(`Using ${config.bedrock ? 'AWS Bedrock' : 'Anthropic API'} authentication; model: ${config.model}`);
  if (!process.env.GITHUB_TOKEN) console.warn('GITHUB_TOKEN is not set; public GitHub API requests are limited to 60/hour.');

  let progress: ReviewProgress | undefined;
  const orchestrator = new CodeReviewOrchestrator({ ...config, onProgress: event => progress?.handle(event) });
  const generator = new ReportGenerator();
  const output = resolve(cli.output ?? join(config.projectRoot, 'reports'));
  await mkdir(output, { recursive: true });

  for (const prNumber of cli.numbers) {
    const label = `PR #${prNumber}`;
    progress = new ReviewProgress(label, Object.keys(agents).length);
    progress.start();
    let report: ReviewReport;
    try {
      report = await orchestrator.reviewPullRequest(cli.owner, cli.repo, prNumber);
    } catch (error) {
      progress.fail(`${label}: review failed`);
      throw error;
    }
    progress.succeed(`${label}: review complete, score ${report.summary.overallScore}/100`);
    progress = undefined;

    const stem = `${cli.owner}_${cli.repo}_${prNumber}`;
    await writeReports(output, stem, generator, report);
    console.log(`${label}: ${report.summary.totalFiles} files, score ${report.summary.overallScore}/100. ` +
      `Reports: ${join(output, stem)}.{json,md,html}`);

    if (cli.postComment) {
      const url = await postReviewComment(report.pullRequest, generator.generatePullRequestComment(report));
      console.log(`${label}: posted review summary comment${url ? ` ${url}` : ''}`);
    }
  }
}

function redactSecrets(message: string): string {
  let redacted = message;
  for (const secret of [process.env.ANTHROPIC_API_KEY, process.env.GITHUB_TOKEN, process.env.AWS_SECRET_ACCESS_KEY]) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const cause = error instanceof Error && error.cause ? `: ${formatError(error.cause)}` : '';
    console.error(`Review failed: ${redactSecrets(`${formatError(error)}${cause}`)}`);
    process.exitCode = 1;
  });
}
