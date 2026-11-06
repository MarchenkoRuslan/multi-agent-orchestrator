import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseCliArgs, validateEnvironment } from '../src/main.js';
import { postReviewComment } from '../src/mcp/pr-commenter.js';
import { CodeReviewOrchestrator } from '../src/orchestrator.js';
import { ReviewReportSchema } from '../src/types/report-types.js';
import { validReport } from './fixtures/review-report.js';

vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('../src/mcp/pr-commenter.js', () => ({
  postReviewComment: vi.fn().mockResolvedValue('https://github.com/udacity/cd14715-simple-todo-app/pull/2#issuecomment-1')
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function stubValidEnvironment(): void {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real');
  vi.stubEnv('ANTHROPIC_MODEL', 'test-model');
  vi.stubEnv('ANTHROPIC_BASE_URL', '');
  vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');
  vi.stubEnv('PROJECT_ROOT', fileURLToPath(new URL('..', import.meta.url)));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

function mockReviews() {
  return vi.spyOn(CodeReviewOrchestrator.prototype, 'reviewPullRequest').mockImplementation(async (owner, repo, number) => {
    const report = ReviewReportSchema.parse(structuredClone(validReport));
    report.pullRequest = { owner, repo, number };
    return report;
  });
}

describe('CLI', () => {
  it('parses a single PR or all three required PRs', () => {
    expect(parseCliArgs(['udacity', 'todos', '2'])).toMatchObject({ owner: 'udacity', repo: 'todos', numbers: [2], postComment: false });
    expect(parseCliArgs(['udacity', 'todos', '--all'])).toMatchObject({ numbers: [1, 2, 3] });
    expect(parseCliArgs(['udacity', 'todos', '2', '--post-comment'])).toMatchObject({ postComment: true });
    expect(parseCliArgs(['--help'])).toEqual({ help: true });
  });

  it('explains what is wrong together with usage when arguments are missing or unknown', () => {
    expect(() => parseCliArgs(['udacity', 'todos'])).toThrow(/Expected exactly three arguments[\s\S]*Usage: npm start/);
    expect(() => parseCliArgs(['udacity', 'todos', '1', '--bogus'])).toThrow(/Unknown option[\s\S]*Usage: npm start/);
  });

  it.each(['0', '-1', '1.5', '12abc', 'Infinity', '9007199254740992'])('rejects invalid PR number %s', number => {
    expect(() => parseCliArgs(['udacity', 'todos', number])).toThrow();
  });

  it('rejects extra arguments and path traversal', () => {
    expect(() => parseCliArgs(['udacity', 'todos', '1', 'extra'])).toThrow();
    expect(() => parseCliArgs(['../bad', 'todos', '1'])).toThrow();
    expect(() => parseCliArgs(['udacity', '..', '1'])).toThrow();
    expect(() => parseCliArgs(['udacity', 'todos', '--all', '1'])).toThrow();
  });

  it('validates credentials, model, absolute project root, and endpoint', async () => {
    const env = { ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_MODEL: 'test',
      PROJECT_ROOT: fileURLToPath(new URL('..', import.meta.url)) };
    await expect(validateEnvironment(env)).resolves.toMatchObject({ model: 'test', bedrock: false });
    await expect(validateEnvironment({ ...env, ANTHROPIC_API_KEY: '' })).rejects.toMatchObject({ code: 'MISSING_API_KEY' });
    await expect(validateEnvironment({ ...env, ANTHROPIC_MODEL: '' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(validateEnvironment({ ...env, PROJECT_ROOT: './relative' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(validateEnvironment({ ...env, ANTHROPIC_BASE_URL: 'http://remote.example' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(validateEnvironment({ ...env, REVIEW_TIMEOUT_MINUTES: '45' })).resolves.toMatchObject({ timeoutMs: 2_700_000 });
    await expect(validateEnvironment({ ...env, REVIEW_TIMEOUT_MINUTES: 'soon' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('generates exactly nine schema-valid report files with assignment filenames in all mode', async () => {
    const output = await mkdtemp(join(tmpdir(), 'devflow-cli-test-'));
    stubValidEnvironment();
    const review = mockReviews();
    try {
      await main(['udacity', 'cd14715-simple-todo-app', '--all', '--output', output]);
      const expected = [1, 2, 3].flatMap(number => ['json', 'md', 'html'].map(extension =>
        `udacity_cd14715-simple-todo-app_${number}.${extension}`));
      expect((await readdir(output)).sort()).toEqual(expected.sort());
      expect(review).toHaveBeenCalledTimes(3);
      for (const number of [1, 2, 3]) {
        const stem = `udacity_cd14715-simple-todo-app_${number}`;
        const report = ReviewReportSchema.parse(JSON.parse(await readFile(join(output, `${stem}.json`), 'utf8')));
        expect(report.pullRequest.number).toBe(number);
        expect(await readFile(join(output, `${stem}.md`), 'utf8')).toContain('toEqual(todos)');
        expect(await readFile(join(output, `${stem}.html`), 'utf8')).toContain('<!doctype html>');
      }
      expect(postReviewComment).not.toHaveBeenCalled();
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });

  it('posts the summary comment only when --post-comment is given and GITHUB_TOKEN is set', async () => {
    const output = await mkdtemp(join(tmpdir(), 'devflow-cli-test-'));
    stubValidEnvironment();
    mockReviews();
    try {
      vi.stubEnv('GITHUB_TOKEN', '');
      await expect(main(['udacity', 'cd14715-simple-todo-app', '2', '--post-comment', '--output', output]))
        .rejects.toMatchObject({ code: 'MISSING_GITHUB_TOKEN' });
      expect(postReviewComment).not.toHaveBeenCalled();

      vi.stubEnv('GITHUB_TOKEN', 'test-token-not-real');
      await main(['udacity', 'cd14715-simple-todo-app', '2', '--post-comment', '--output', output]);
      expect(postReviewComment).toHaveBeenCalledWith({ owner: 'udacity', repo: 'cd14715-simple-todo-app', number: 2 },
        expect.stringContaining('## DevFlow Code Review: PR #2'));
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});