import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { createSnapshotServerConfig } from '../config/mcp.config.js';
import { ErrorCodes, ReviewError } from '../utils/error-handler.js';

const ChangedFileSchema = z.object({ filename: z.string(), status: z.string(), patch: z.string().optional() });
const PullRequestSchema = z.object({ title: z.string(), html_url: z.string().url(), changed_files: z.number(),
  head: z.object({ sha: z.string(), repo: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }).nullable() }),
  base: z.object({ sha: z.string(), repo: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }) }) });

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
  if (file.includes('\\') || file.includes(':') || file.split('/').some(part => part === '..' || part === '.' || part === '')) {
    throw new ReviewError(`Unsafe repository path: ${file}`, ErrorCodes.VALIDATION_FAILED);
  }
  const target = resolve(directory, file);
  const local = relative(resolve(directory), target);
  if (local.startsWith('..') || local === '') throw new ReviewError('Path escapes snapshot', ErrorCodes.VALIDATION_FAILED);
  return target;
}

export async function fetchPullRequestSnapshot(owner: string, repo: string, prNumber: number, projectRoot: string): Promise<PullRequestSnapshot> {
  const config = createSnapshotServerConfig();
  const client = new Client({ name: 'devflow-snapshot-fetcher', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' });
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
    const parsed = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()) }).parse(response);
    const text = parsed.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    if (parsed.isError) {
      const code = text.includes('PR_NOT_FOUND') ? ErrorCodes.PR_NOT_FOUND : text.includes('RATE_LIMITED') ? ErrorCodes.RATE_LIMITED : ErrorCodes.GITHUB_API_ERROR;
      throw new ReviewError(text, code);
    }
    return JSON.parse(text) as unknown;
  };
  try {
    await client.connect(transport);
    const args = { owner, repo, pull_number: prNumber };
    const pr = PullRequestSchema.parse(await call('get_pull_request', args));
    if (!pr.head.repo) throw new ReviewError('PR head repository is unavailable', ErrorCodes.FILE_NOT_FOUND);
    const changed = z.array(ChangedFileSchema).parse(await call('get_pull_request_files', args));
    if (changed.length !== pr.changed_files || changed.length > 300) {
      throw new ReviewError('Incomplete or oversized changed-file list (maximum 300 files)', ErrorCodes.VALIDATION_FAILED);
    }
    const sourceRepo = { owner: pr.head.repo.owner.login, repo: pr.head.repo.name };
    const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), type: z.string() })) })
      .parse(await call('get_repository_tree', { ...sourceRepo, sha: pr.head.sha }));
    if (tree.truncated) throw new ReviewError('GitHub returned a truncated repository tree', ErrorCodes.VALIDATION_FAILED);
    const supporting = tree.tree.filter(entry => entry.type === 'blob' &&
      (/\.(?:[cm]?[jt]sx?|html|css)$/.test(entry.path) || entry.path === 'package.json') &&
      !/(^|\/)(node_modules|dist|build|vendor|\.claude)\//.test(entry.path) &&
      !changed.some(file => file.filename === entry.path)).map(entry => entry.path);
    if (supporting.length > 100) throw new ReviewError('Repository context exceeds 100 supporting files; narrow the review scope', ErrorCodes.VALIDATION_FAILED);
    const workRoot = join(projectRoot, '.reviews');
    await mkdir(workRoot, { recursive: true });
    const directory = await mkdtemp(join(workRoot, `${owner}-${repo}-${prNumber}-`));
    await cp(join(projectRoot, '.claude', 'skills'), join(directory, '.claude', 'skills'), { recursive: true });
    await writeFile(join(directory, 'eslint.config.mjs'), `export default [{ files: ["source/**/*.{js,mjs,cjs,jsx}"], languageOptions: { ecmaVersion: "latest", sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } }, rules: { "no-eval": "error", "no-implied-eval": "error", "no-unreachable": "error", "no-constant-condition": "warn", "eqeqeq": "warn" } }];\n`);
    const files: SnapshotFile[] = [];
    const supportingFiles: string[] = [];
    let totalBytes = 0;
    const store = async (file: string, fromBase = false): Promise<{ localPath: string; lineCount: number }> => {
      const reference = fromBase ? { owner: pr.base.repo.owner.login, repo: pr.base.repo.name, ref: pr.base.sha } : { ...sourceRepo, ref: pr.head.sha };
      const data = z.object({ content: z.string() }).parse(await call('get_file_contents', { ...reference, path: file }));
      totalBytes += Buffer.byteLength(data.content);
      if (totalBytes > 5 * 1024 * 1024 || data.content.includes('\u0000')) {
        throw new ReviewError('Snapshot exceeds 5 MB or contains an unsupported binary file', ErrorCodes.VALIDATION_FAILED);
      }
      const unsafeConfig = /(^|\/)(?:\.claude|node_modules)(\/|$)|(^|\/)eslint\.config\.|(^|\/)(?:CLAUDE|AGENTS)\.md$/.test(file);
      const localPath = unsafeConfig ? join(directory, 'evidence', `${encodeURIComponent(file)}.txt`) :
        safeSnapshotPath(join(directory, 'source'), file);
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(localPath, data.content, 'utf8');
      return { localPath, lineCount: Math.max(1, data.content.split('\n').length) };
    };
    for (const file of changed) {
      files.push({ file: file.filename, status: file.status, patch: file.patch, ...await store(file.filename, file.status === 'removed') });
    }
    for (const file of supporting) supportingFiles.push((await store(file)).localPath);
    const snapshot = { directory, title: pr.title, url: pr.html_url, headSha: pr.head.sha, baseSha: pr.base.sha, files, supportingFiles };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(snapshot, null, 2));
    return snapshot;
  } finally {
    await client.close();
    await transport.close();
  }
}