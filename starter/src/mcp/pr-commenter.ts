import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { createMcpServersConfig } from '../config/mcp.config.js';
import type { ReviewReport } from '../types/report-types.js';
import { ErrorCodes, ReviewError } from '../utils/error-handler.js';

/** GitHub rejects comment bodies over 65,536 characters; keep a safety margin. */
export const MAX_COMMENT_LENGTH = 60_000;
const TRUNCATION_NOTICE = '\n\n_Comment truncated; see the full report artifacts._\n';
const CALL_TIMEOUT_MS = 60_000;

const ToolResponseSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())
});

export interface CommentToolClient {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export type CommentClientFactory = () => Promise<CommentToolClient>;

export function truncateComment(body: string, maxLength = MAX_COMMENT_LENGTH): string {
  if (body.length <= maxLength) return body;
  return body.slice(0, maxLength - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE;
}

/**
 * Connects to the same GitHub MCP server (npx @modelcontextprotocol/server-github) the orchestrator uses.
 */
export const connectGitHubMcp: CommentClientFactory = async () => {
  const config = createMcpServersConfig().github as { command: string; args?: string[]; env?: Record<string, string> };
  const client = new Client({ name: 'devflow-pr-commenter', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' });
  await client.connect(transport);
  return {
    callTool: request => client.callTool(request, undefined, { timeout: CALL_TIMEOUT_MS }),
    close: async () => {
      await client.close();
      await transport.close();
    }
  };
};

/**
 * Posts the review summary as a comment on the pull request via the GitHub MCP `add_issue_comment` tool.
 * Opt-in only (CLI flag `--post-comment`); requires a GITHUB_TOKEN that may comment on the repository.
 * @returns The comment URL when GitHub reports one.
 */
export async function postReviewComment(
  pullRequest: ReviewReport['pullRequest'],
  body: string,
  connect: CommentClientFactory = connectGitHubMcp
): Promise<string | undefined> {
  if (!process.env.GITHUB_TOKEN?.trim()) {
    throw new ReviewError('Posting a PR comment requires GITHUB_TOKEN with permission to comment on the repository',
      ErrorCodes.MISSING_GITHUB_TOKEN);
  }
  const client = await connect();
  try {
    const response = ToolResponseSchema.parse(await client.callTool({
      name: 'add_issue_comment',
      arguments: { owner: pullRequest.owner, repo: pullRequest.repo, issue_number: pullRequest.number, body: truncateComment(body) }
    }));
    const text = response.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
    if (response.isError) {
      throw new ReviewError(`GitHub MCP add_issue_comment failed: ${text.slice(0, 500)}`, ErrorCodes.GITHUB_API_ERROR);
    }
    try {
      return z.object({ html_url: z.string().url() }).parse(JSON.parse(text)).html_url;
    } catch {
      return undefined;
    }
  } finally {
    await client.close();
  }
}
