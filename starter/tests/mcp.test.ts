import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createMcpServersConfig, createSnapshotServerConfig } from '../src/config/mcp.config.js';

describe('MCP subprocess integration without network calls', () => {
  it.each([
    ['github', ['get_pull_request', 'get_pull_request_files', 'get_file_contents']],
    ['eslint', ['lint-files']]
  ] as const)('starts %s and discovers its expected tools', async (name, expected) => {
    const config = createMcpServersConfig()[name]!;
    if (!('command' in config)) throw new Error('Expected stdio MCP transport');
    const client = new Client({ name: 'devflow-mcp-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: config.command, args: config.args,
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...config.env, npm_config_offline: 'true', npm_config_update_notifier: 'false' }, stderr: 'pipe' });
    let diagnostic = '';
    transport.stderr?.on('data', data => { diagnostic += String(data); });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name), diagnostic).toEqual(expect.arrayContaining([...expected]));
    } finally {
      await client.close();
      await transport.close();
    }
  }, 60000);

  it('starts the bundled snapshot server in source mode with read-only tools', async () => {
    const config = createSnapshotServerConfig();
    const client = new Client({ name: 'devflow-snapshot-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map(tool => tool.name)).toContain('get_repository_tree');
      expect(tools.every(tool => tool.annotations?.readOnlyHint === true)).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30000);
});