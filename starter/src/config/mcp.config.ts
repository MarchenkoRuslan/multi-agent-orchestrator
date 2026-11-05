/**
 * Model Context Protocol (MCP) server configurations
 *
 * Required MCP Servers:
 * 1. GitHub - For PR/repo operations
 * 2. ESLint - For code linting and style analysis
 *
 * Documentation:
 * - MCP Protocol: https://modelcontextprotocol.io
 * - GitHub MCP: https://github.com/github/github-mcp-server
 * - ESLint MCP: https://eslint.org/docs/latest/use/mcp
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';

const require = createRequire(import.meta.url);

export const mcpServersConfig = {
  github: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' }
  },
  eslint: {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@eslint/mcp'],
    env: {}
  }
} satisfies Record<string, McpServerConfig>;

export function createMcpServersConfig(): Record<string, McpServerConfig> {
  return { ...mcpServersConfig, github: { ...mcpServersConfig.github,
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' } } };
}

export function createSnapshotServerConfig() {
  const githubScript = fileURLToPath(new URL('../mcp/github-server.js', import.meta.url));
  return {
    type: 'stdio' as const,
    command: process.execPath,
    args: existsSync(githubScript) ? [githubScript] :
      ['--import', pathToFileURL(require.resolve('tsx')).href, fileURLToPath(new URL('../mcp/github-server.ts', import.meta.url))],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' }
  };
}
