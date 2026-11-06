import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createSnapshotServerConfig } from '../config/mcp.config.js';
import { ErrorCodes, ReviewError } from '../utils/error-handler.js';

const require = createRequire(import.meta.url);

const RepositoryRefSchema = z.object({ name: z.string(), owner: z.object({ login: z.string() }) });
const ChangedFileSchema = z.object({ filename: z.string(), status: z.string(), patch: z.string().optional() });
const PullRequestSchema = z.object({
  title: z.string(),
  html_url: z.string().url(),
  changed_files: z.number(),
  head: z.object({ sha: z.string(), repo: RepositoryRefSchema.nullable() }),
  base: z.object({ sha: z.string(), repo: RepositoryRefSchema })
});
const ToolResponseSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
});
const TreeSchema = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), type: z.string() })) });

const MAX_CHANGED_FILES = 300;
const MAX_SUPPORTING_FILES = 100;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const SUPPORTING_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|html|css)$/;
const EXCLUDED_DIRECTORY_PATTERN = /(^|\/)(node_modules|dist|build|vendor|\.claude)\//;
const UNSAFE_CONFIG_PATTERN = /(^|\/)(?:\.claude|node_modules)(\/|$)|(^|\/)eslint\.config\.|(^|\/)(?:CLAUDE|AGENTS)\.md$/;
const SHARED_LINT_RULES = {
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-unreachable': 'error',
  'no-constant-condition': 'warn',
  eqeqeq: 'warn'
};

/**
 * Trusted ESLint flat config written into every snapshot. JavaScript uses the default parser;
 * TypeScript uses the typescript-eslint parser without type information, so no repository
 * tsconfig or code is loaded or executed.
 */
export function buildEslintConfig(): string {
  const typescriptEslint = pathToFileURL(require.resolve('typescript-eslint')).href;
  return `import tseslint from ${JSON.stringify(typescriptEslint)};
const rules = ${JSON.stringify(SHARED_LINT_RULES)};
export default [
  { files: ["source/**/*.{js,mjs,cjs,jsx}"],
    languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
    rules },
  { files: ["source/**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tseslint.parser, ecmaVersion: "latest", sourceType: "module" },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: { ...rules, "@typescript-eslint/no-explicit-any": "warn", "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn" } }
];
`;
}

export interface SnapshotFile {
  file: string;
  status: string;
  localPath: string;
  lineCount: number;
  patch?: string;
}

export interface PullRequestSnapshot {
  directory: string;
  title: string;
  url: string;
  headSha: string;
  baseSha: string;
  files: SnapshotFile[];
  supportingFiles: string[];
}

export function safeSnapshotPath(directory: string, file: string): string {
  const hasUnsafeSegment = file.split('/').some(part => part === '..' || part === '.' || part === '');
  if (file.includes('\\') || file.includes(':') || hasUnsafeSegment) {
    throw new ReviewError(`Unsafe repository path: ${file}`, ErrorCodes.VALIDATION_FAILED);
  }
  const target = resolve(directory, file);
  const local = relative(resolve(directory), target);
  if (local.startsWith('..') || local === '') throw new ReviewError('Path escapes snapshot', ErrorCodes.VALIDATION_FAILED);
  return target;
}

function toolErrorCode(text: string): string {
  if (text.includes('PR_NOT_FOUND')) return ErrorCodes.PR_NOT_FOUND;
  if (text.includes('RATE_LIMITED')) return ErrorCodes.RATE_LIMITED;
  return ErrorCodes.GITHUB_API_ERROR;
}

export async function fetchPullRequestSnapshot(
  owner: string,
  repo: string,
  prNumber: number,
  projectRoot: string
): Promise<PullRequestSnapshot> {
  const config = createSnapshotServerConfig();
  const client = new Client({ name: 'devflow-snapshot-fetcher', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' });

  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = ToolResponseSchema.parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 }));
    const text = response.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    if (response.isError) throw new ReviewError(text, toolErrorCode(text));
    return JSON.parse(text) as unknown;
  };

  try {
    await client.connect(transport);
    const args = { owner, repo, pull_number: prNumber };
    const pr = PullRequestSchema.parse(await call('get_pull_request', args));
    if (!pr.head.repo) throw new ReviewError('PR head repository is unavailable', ErrorCodes.FILE_NOT_FOUND);

    const changed = z.array(ChangedFileSchema).parse(await call('get_pull_request_files', args));
    if (changed.length !== pr.changed_files || changed.length > MAX_CHANGED_FILES) {
      throw new ReviewError(`Incomplete or oversized changed-file list (maximum ${MAX_CHANGED_FILES} files)`, ErrorCodes.VALIDATION_FAILED);
    }

    const sourceRepo = { owner: pr.head.repo.owner.login, repo: pr.head.repo.name };
    const tree = TreeSchema.parse(await call('get_repository_tree', { ...sourceRepo, sha: pr.head.sha }));
    if (tree.truncated) throw new ReviewError('GitHub returned a truncated repository tree', ErrorCodes.VALIDATION_FAILED);
    const supporting = tree.tree
      .filter(entry => entry.type === 'blob')
      .map(entry => entry.path)
      .filter(path => SUPPORTING_FILE_PATTERN.test(path) || path === 'package.json')
      .filter(path => !EXCLUDED_DIRECTORY_PATTERN.test(path))
      .filter(path => !changed.some(file => file.filename === path));
    if (supporting.length > MAX_SUPPORTING_FILES) {
      throw new ReviewError(`Repository context exceeds ${MAX_SUPPORTING_FILES} supporting files; narrow the review scope`,
        ErrorCodes.VALIDATION_FAILED);
    }

    const workRoot = join(projectRoot, '.reviews');
    await mkdir(workRoot, { recursive: true });
    const directory = await mkdtemp(join(workRoot, `${owner}-${repo}-${prNumber}-`));
    await cp(join(projectRoot, '.claude', 'skills'), join(directory, '.claude', 'skills'), { recursive: true });
    await writeFile(join(directory, 'eslint.config.mjs'), buildEslintConfig());

    let totalBytes = 0;
    const store = async (file: string, fromBase = false): Promise<{ localPath: string; lineCount: number }> => {
      const reference = fromBase
        ? { owner: pr.base.repo.owner.login, repo: pr.base.repo.name, ref: pr.base.sha }
        : { ...sourceRepo, ref: pr.head.sha };
      const data = z.object({ content: z.string() }).parse(await call('get_file_contents', { ...reference, path: file }));
      totalBytes += Buffer.byteLength(data.content);
      if (totalBytes > MAX_SNAPSHOT_BYTES || data.content.includes('\u0000')) {
        throw new ReviewError('Snapshot exceeds 5 MB or contains an unsupported binary file', ErrorCodes.VALIDATION_FAILED);
      }
      // Repository files that could act as agent or lint configuration are stored as inert evidence text.
      const localPath = UNSAFE_CONFIG_PATTERN.test(file)
        ? join(directory, 'evidence', `${encodeURIComponent(file)}.txt`)
        : safeSnapshotPath(join(directory, 'source'), file);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, data.content, 'utf8');
      return { localPath, lineCount: Math.max(1, data.content.split('\n').length) };
    };

    const files: SnapshotFile[] = [];
    for (const file of changed) {
      const stored = await store(file.filename, file.status === 'removed');
      files.push({ file: file.filename, status: file.status, patch: file.patch, ...stored });
    }
    const supportingFiles: string[] = [];
    for (const file of supporting) supportingFiles.push((await store(file)).localPath);

    const snapshot: PullRequestSnapshot = {
      directory, title: pr.title, url: pr.html_url, headSha: pr.head.sha, baseSha: pr.base.sha, files, supportingFiles
    };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(snapshot, null, 2));
    return snapshot;
  } finally {
    await client.close();
    await transport.close();
  }
}