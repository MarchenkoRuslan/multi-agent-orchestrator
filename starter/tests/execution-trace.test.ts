import { describe, expect, it, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describeToolCall, ExecutionTracker, type ReviewProgressEvent } from '../src/utils/execution-tracker.js';
import { buildSequenceDiagram, sanitizeMermaidText, summarizeToolUsage } from '../src/utils/mermaid.js';

const agentNames = ['code-quality-analyzer', 'test-coverage-analyzer', 'refactoring-suggester'];

const assistant = (parent: string | null, content: unknown[]): SDKMessage =>
  ({ type: 'assistant', parent_tool_use_id: parent, message: { content } }) as unknown as SDKMessage;
const toolResults = (content: unknown[]): SDKMessage =>
  ({ type: 'user', parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;

describe('ExecutionTracker', () => {
  it('attributes subagent tool calls via parent_tool_use_id and reports progress', () => {
    const events: ReviewProgressEvent[] = [];
    let clock = 1_000;
    const tracker = new ExecutionTracker(agentNames, event => events.push(event), () => clock);

    tracker.handle(assistant(null, [
      { type: 'text', text: 'Delegating' },
      { type: 'tool_use', id: 'task-1', name: 'Task', input: { subagent_type: 'code-quality-analyzer', prompt: 'review' } }
    ]));
    tracker.handle(assistant('task-1', [
      { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'typescript-patterns' } },
      { type: 'tool_use', id: 't2', name: 'mcp__eslint__lint-files', input: { filePaths: ['/s/source/src/todo.ts'] } },
      { type: 'tool_use', id: 't3', name: 'Read', input: { file_path: 'C:\\snap\\source\\src\\todo.ts' } }
    ]));
    clock = 4_500;
    tracker.handle(toolResults([{ type: 'tool_result', tool_use_id: 'task-1', content: 'done' }]));

    expect(tracker.trace).toEqual([
      { from: 'orchestrator', to: 'code-quality-analyzer', label: 'Task', kind: 'call' },
      { from: 'code-quality-analyzer', to: 'Claude Skills', label: 'Skill typescript-patterns', kind: 'call' },
      { from: 'code-quality-analyzer', to: 'ESLint MCP', label: 'lint-files', kind: 'call' },
      { from: 'code-quality-analyzer', to: 'PR snapshot', label: 'Read todo.ts', kind: 'call' },
      { from: 'code-quality-analyzer', to: 'orchestrator', label: 'findings', kind: 'return' }
    ]);
    expect(events[0]).toEqual({ type: 'agent-started', agent: 'code-quality-analyzer' });
    expect(events.at(-1)).toEqual({ type: 'agent-completed', agent: 'code-quality-analyzer', success: true, durationMs: 3_500 });
    expect(tracker.missingAgents()).toEqual(['test-coverage-analyzer', 'refactoring-suggester']);
  });

  it('treats an errored Task result as a failed specialist', () => {
    const onProgress = vi.fn();
    const tracker = new ExecutionTracker(agentNames, onProgress);
    tracker.handle(assistant(null, agentNames.map(name => ({ type: 'tool_use', id: name, name: 'Task', input: { subagent_type: name } }))));
    tracker.handle(toolResults(agentNames.map(name => ({ type: 'tool_result', tool_use_id: name, is_error: name === 'refactoring-suggester' }))));
    expect(tracker.missingAgents()).toEqual(['refactoring-suggester']);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ type: 'agent-completed', agent: 'refactoring-suggester', success: false }));
    expect(tracker.trace.at(-1)).toMatchObject({ from: 'refactoring-suggester', label: 'failed', kind: 'return' });
  });

  it('maps tools to diagram participants', () => {
    expect(describeToolCall('mcp__github__get_pull_request', {})).toEqual({ target: 'GitHub MCP', label: 'get_pull_request' });
    expect(describeToolCall('Grep', { pattern: 'SELECT' })).toEqual({ target: 'PR snapshot', label: 'Grep SELECT' });
    expect(describeToolCall('StructuredOutput', {})).toEqual({ target: 'Claude Code tools', label: 'StructuredOutput' });
  });
});

describe('Mermaid execution diagram', () => {
  const trace = [
    { from: 'orchestrator', to: 'code-quality-analyzer', label: 'Task', kind: 'call' as const },
    { from: 'code-quality-analyzer', to: 'PR snapshot', label: 'Grep x;%%{init}%% <script>', kind: 'call' as const },
    { from: 'code-quality-analyzer', to: 'orchestrator', label: 'findings', kind: 'return' as const }
  ];

  it('renders a sequence diagram with declared participants and call/return arrows', () => {
    const diagram = buildSequenceDiagram(trace);
    expect(diagram.split('\n')).toEqual([
      'sequenceDiagram',
      '  participant P0 as orchestrator',
      '  participant P1 as code-quality-analyzer',
      '  participant P2 as PR snapshot',
      '  P0->>P1: Task',
      '  P1->>P2: Grep x init script',
      '  P1-->>P0: findings'
    ]);
  });

  it('strips diagram syntax from untrusted labels and caps long traces', () => {
    expect(sanitizeMermaidText('a;b%%{init: {"theme":"x"}}%%<b>c</b>#1')).toBe('a b init theme x b c /b 1');
    const long = Array.from({ length: 5 }, () => trace[0]!);
    expect(buildSequenceDiagram(long, 2)).toContain('Note over P0: 3 more steps omitted');
  });

  it('counts tool calls per actor', () => {
    expect(summarizeToolUsage(trace)).toEqual(new Map([
      ['orchestrator', new Map([['Task', 1]])],
      ['code-quality-analyzer', new Map([['Grep', 1]])]
    ]));
  });
});
