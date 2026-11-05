import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v3';

const repository = { owner: z.string().regex(/^[\w-]+$/), repo: z.string().regex(/^[\w.-]+$/) };
const server = new McpServer({ name: 'devflow-github-readonly', version: '1.0.0' });

async function github(path: string): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json',
    'User-Agent': 'DevFlow-Code-Review', 'X-GitHub-Api-Version': '2022-11-28' };
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_PERSONAL_ACCESS_TOKEN}`;
  const response = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    const code = response.status === 404 ? 'PR_NOT_FOUND' :
      response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') ? 'RATE_LIMITED' : 'GITHUB_API_ERROR';
    throw new Error(`${code}: GitHub returned HTTP ${response.status}; retry-after=${response.headers.get('retry-after') ?? 'unknown'}`);
  }
  return response.json();
}

function result(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
}

server.registerTool('pull_request_read', {
  description: 'Read pull request metadata at the GitHub MCP-compatible tool name. Supported method: get.',
  inputSchema: { ...repository, pullNumber: z.number().int().positive(), method: z.literal('get') },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ owner, repo, pullNumber }) => result(await github(`/repos/${owner}/${repo}/pulls/${pullNumber}`)));

server.registerTool('get_pull_request', {
  description: 'Read pull request metadata including its exact head commit and source repository.',
  inputSchema: { ...repository, pull_number: z.number().int().positive() },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ owner, repo, pull_number }) => result(await github(`/repos/${owner}/${repo}/pulls/${pull_number}`)));

server.registerTool('get_pull_request_files', {
  description: 'Read the complete paginated changed-file list and patches of a pull request.',
  inputSchema: { ...repository, pull_number: z.number().int().positive() },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ owner, repo, pull_number }) => {
  const files: unknown[] = [];
  for (let page = 1; page <= 30; page++) {
    const batch = z.array(z.unknown()).parse(await github(`/repos/${owner}/${repo}/pulls/${pull_number}/files?per_page=100&page=${page}`));
    files.push(...batch);
    if (batch.length < 100) return result(files);
  }
  throw new Error('VALIDATION_FAILED: PR exceeds the 3000-file GitHub API limit');
});

server.registerTool('get_repository_tree', {
  description: 'Discover source and test paths at a pinned commit. Does not execute repository code.',
  inputSchema: { ...repository, sha: z.string().regex(/^[a-f0-9]{40}$/) },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ owner, repo, sha }) => result(await github(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`)));

server.registerTool('get_file_contents', {
  description: 'Read UTF-8 file contents at a pinned commit; returns size, encoding, content and blob SHA.',
  inputSchema: { ...repository, path: z.string().min(1), ref: z.string().regex(/^[a-f0-9]{40}$/) },
  annotations: { readOnlyHint: true, destructiveHint: false }
}, async ({ owner, repo, path, ref }) => {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const data = z.object({ type: z.literal('file'), size: z.number().max(262144), encoding: z.literal('base64'),
    content: z.string(), sha: z.string() }).parse(await github(`/repos/${owner}/${repo}/contents/${encoded}?ref=${ref}`));
  return result({ ...data, encoding: 'utf-8', content: Buffer.from(data.content, 'base64').toString('utf8') });
});

await server.connect(new StdioServerTransport());