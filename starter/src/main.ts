import * as dotenv from 'dotenv';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CodeReviewOrchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';
import { ErrorCodes, ReviewError, formatError } from './utils/error-handler.js';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));

export function parseCliArgs(args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, strict: true,
    options: { all: { type: 'boolean', default: false }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return { help: true as const };
  const [owner, repo, number] = positionals;
  if (!owner || !repo || !/^[\w-]+$/.test(owner) || !/^[\w.-]+$/.test(repo) || repo === '.' || repo === '..' ||
    positionals.length !== (values.all ? 2 : 3) || (!values.all && (!number || !/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))))) {
    throw new ReviewError('Usage: npm start -- <owner> <repo> <pr-number> [--output <directory>]\n       npm start -- <owner> <repo> --all', ErrorCodes.VALIDATION_FAILED);
  }
  return { help: false as const, owner, repo, numbers: values.all ? [1, 2, 3] : [Number(number)], output: values.output };
}

export async function validateEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const bedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  if (bedrock) {
    if (!env.AWS_REGION || (!env.AWS_PROFILE && (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY))) {
      throw new ReviewError('Bedrock requires AWS_REGION and AWS_PROFILE or AWS access-key credentials', ErrorCodes.INVALID_CONFIG);
    }
  } else if (!env.ANTHROPIC_API_KEY?.trim()) {
    throw new ReviewError('Set ANTHROPIC_API_KEY in your environment, or configure CLAUDE_CODE_USE_BEDROCK=1 with AWS credentials', ErrorCodes.MISSING_API_KEY);
  }
  if (!env.ANTHROPIC_MODEL?.trim()) throw new ReviewError('ANTHROPIC_MODEL environment variable is required', ErrorCodes.INVALID_CONFIG);
  if (!env.PROJECT_ROOT || !isAbsolute(env.PROJECT_ROOT)) throw new ReviewError('PROJECT_ROOT must be an absolute path to project/starter', ErrorCodes.INVALID_CONFIG);
  if (env.ANTHROPIC_BASE_URL) {
    let url: URL;
    try { url = new URL(env.ANTHROPIC_BASE_URL); } catch { throw new ReviewError('ANTHROPIC_BASE_URL must be a valid URL', ErrorCodes.INVALID_CONFIG); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new ReviewError('Invalid API endpoint URL', ErrorCodes.INVALID_CONFIG);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new ReviewError('Remote API endpoints must use HTTPS', ErrorCodes.INVALID_CONFIG);
    }
  }
  try { await access(join(env.PROJECT_ROOT, '.claude', 'skills')); } catch {
    throw new ReviewError('PROJECT_ROOT must contain .claude/skills; build and run from project/starter', ErrorCodes.INVALID_CONFIG);
  }
  return { projectRoot: resolve(env.PROJECT_ROOT), model: env.ANTHROPIC_MODEL, bedrock };
}

/**
 * Main entry point for the Claude Multi-Agent Code Review System
 * Usage: npm run dev <owner> <repo> <pr-number>
 */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const cli = parseCliArgs(args);
  if (cli.help) {
    console.log('Usage: npm start -- <owner> <repo> <pr-number> [--output <directory>]\n       npm start -- <owner> <repo> --all\n--all analyzes PRs 1, 2, and 3. Outputs JSON, Markdown, and HTML.');
    return;
  }
  dotenv.config({ path: join(defaultRoot, '.env'), override: true });
  if (process.env.ANTHROPIC_BASE_URL === '') delete process.env.ANTHROPIC_BASE_URL;
  const config = await validateEnvironment();
  console.log(`Using ${config.bedrock ? 'AWS Bedrock' : 'Anthropic API'} authentication; model: ${config.model}`);
  if (!process.env.GITHUB_TOKEN) console.warn('GITHUB_TOKEN is not set; public GitHub API requests are limited to 60/hour.');
  const orchestrator = new CodeReviewOrchestrator(config);
  const generator = new ReportGenerator();
  const output = resolve(cli.output ?? join(config.projectRoot, 'reports'));
  await mkdir(output, { recursive: true });
  for (const number of cli.numbers) {
    console.log(`Reviewing ${cli.owner}/${cli.repo} PR #${number}...`);
    const report = await orchestrator.reviewPullRequest(cli.owner, cli.repo, number);
    const stem = `${cli.owner}_${cli.repo}_${number}`;
    const contents = { json: generator.generateJSONReport(report), md: generator.generateMarkdownReport(report), html: generator.generateHTMLReport(report) };
    for (const [extension, content] of Object.entries(contents)) {
      const target = join(output, `${stem}.${extension}`);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, content, 'utf8');
      await rename(temporary, target);
    }
    console.log(`PR #${number}: ${report.summary.totalFiles} files, score ${report.summary.overallScore}/100. Reports: ${join(output, stem)}.{json,md,html}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const cause = error instanceof Error && error.cause ? `: ${formatError(error.cause)}` : '';
    let message = `${formatError(error)}${cause}`;
    for (const secret of [process.env.ANTHROPIC_API_KEY, process.env.GITHUB_TOKEN, process.env.AWS_SECRET_ACCESS_KEY]) {
      if (secret) message = message.split(secret).join('[REDACTED]');
    }
    console.error(`Review failed: ${message}`);
    process.exitCode = 1;
  });
}
