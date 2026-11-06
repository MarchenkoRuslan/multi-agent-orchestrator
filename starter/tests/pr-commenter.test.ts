import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_COMMENT_LENGTH, postReviewComment, truncateComment, type CommentToolClient } from '../src/mcp/pr-commenter.js';

const pullRequest = { owner: 'octocat', repo: 'Hello-World', number: 1 };

function fakeClient(response: unknown): CommentToolClient & { callTool: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { callTool: vi.fn().mockResolvedValue(response), close: vi.fn().mockResolvedValue(undefined) };
}

afterEach(() => vi.unstubAllEnvs());

describe('postReviewComment', () => {
  it('posts the summary through the GitHub MCP add_issue_comment tool and returns the comment URL', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token-not-real');
    const client = fakeClient({ content: [{ type: 'text', text: JSON.stringify({ html_url: 'https://github.com/octocat/Hello-World/pull/1#issuecomment-1' }) }] });
    const url = await postReviewComment(pullRequest, '## Review', async () => client);
    expect(client.callTool).toHaveBeenCalledWith({ name: 'add_issue_comment',
      arguments: { owner: 'octocat', repo: 'Hello-World', issue_number: 1, body: '## Review' } });
    expect(url).toBe('https://github.com/octocat/Hello-World/pull/1#issuecomment-1');
    expect(client.close).toHaveBeenCalled();
  });

  it('requires GITHUB_TOKEN before connecting', async () => {
    vi.stubEnv('GITHUB_TOKEN', '');
    const connect = vi.fn();
    await expect(postReviewComment(pullRequest, 'body', connect)).rejects.toMatchObject({ code: 'MISSING_GITHUB_TOKEN' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('surfaces GitHub MCP tool errors and still closes the client', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'test-token-not-real');
    const client = fakeClient({ isError: true, content: [{ type: 'text', text: 'Resource not accessible by integration' }] });
    await expect(postReviewComment(pullRequest, 'body', async () => client))
      .rejects.toMatchObject({ code: 'GITHUB_API_ERROR', message: expect.stringContaining('Resource not accessible') });
    expect(client.close).toHaveBeenCalled();
  });

  it('truncates bodies that exceed the GitHub comment limit', () => {
    const body = 'x'.repeat(MAX_COMMENT_LENGTH + 500);
    const truncated = truncateComment(body);
    expect(truncated.length).toBeLessThanOrEqual(MAX_COMMENT_LENGTH);
    expect(truncated).toContain('Comment truncated');
    expect(truncateComment('short')).toBe('short');
  });
});
