import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ExecutionTraceEvent } from '../types/report-types.js';

export const ORCHESTRATOR_ACTOR = 'orchestrator';
const MAX_LABEL_LENGTH = 60;

/**
 * Live progress events emitted while a pull request is being reviewed.
 */
export type ReviewProgressEvent =
  | { type: 'snapshot-ready'; files: number; title: string }
  | { type: 'agent-started'; agent: string }
  | { type: 'agent-completed'; agent: string; success: boolean; durationMs: number }
  | { type: 'tool-call'; actor: string; target: string; label: string }
  | { type: 'retrying'; attempt: number; reason: string }
  | { type: 'aggregating' };

export type ProgressListener = (event: ReviewProgressEvent) => void;

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  is_error?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isToolUse = (block: unknown): block is ToolUseBlock =>
  isRecord(block) && block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string';

const isToolResult = (block: unknown): block is ToolResultBlock =>
  isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string';

const shorten = (text: string): string =>
  text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 3)}...` : text;

const baseName = (path: unknown): string =>
  typeof path === 'string' ? path.split(/[\\/]/).pop() ?? path : '';

const MCP_SERVER_LABELS: Record<string, string> = { github: 'GitHub MCP', eslint: 'ESLint MCP' };

/**
 * Maps a tool invocation to the participant it talks to and a short human-readable label.
 */
export function describeToolCall(name: string, input: Record<string, unknown>): { target: string; label: string } {
  if (name === 'Task') return { target: String(input.subagent_type ?? 'subagent'), label: 'Task' };
  if (name === 'Skill') return { target: 'Claude Skills', label: shorten(`Skill ${String(input.skill ?? input.command ?? '')}`.trim()) };
  if (name === 'Read') return { target: 'PR snapshot', label: shorten(`Read ${baseName(input.file_path)}`.trim()) };
  if (name === 'Grep' || name === 'Glob') return { target: 'PR snapshot', label: shorten(`${name} ${String(input.pattern ?? '')}`.trim()) };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { target: MCP_SERVER_LABELS[mcp[1]!] ?? `${mcp[1]} MCP`, label: shorten(mcp[2]!) };
  return { target: 'Claude Code tools', label: shorten(name) };
}

/**
 * Observes the SDK message stream, attributing every tool call to the orchestrator or to the
 * subagent that made it (via parent_tool_use_id), and tracks which specialist Tasks completed.
 */
export class ExecutionTracker {
  readonly trace: ExecutionTraceEvent[] = [];
  private readonly taskAgents = new Map<string, string>();
  private readonly startedAt = new Map<string, number>();
  private readonly invoked = new Set<string>();
  private readonly completed = new Set<string>();

  constructor(
    private readonly agentNames: readonly string[],
    private readonly onProgress?: ProgressListener,
    private readonly now: () => number = Date.now
  ) {}

  handle(message: SDKMessage): void {
    if (message.type === 'assistant') {
      const actor = this.actorFor(message.parent_tool_use_id);
      for (const block of message.message.content as unknown[]) {
        if (isToolUse(block)) this.recordToolCall(actor, block);
      }
    } else if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content as unknown[]) {
        if (isToolResult(block)) this.recordTaskResult(block);
      }
    }
  }

  /** Specialists that were never started or did not return a successful result. */
  missingAgents(): string[] {
    return this.agentNames.filter(name => !this.invoked.has(name) || !this.completed.has(name));
  }

  private actorFor(parentToolUseId: string | null | undefined): string {
    if (!parentToolUseId) return ORCHESTRATOR_ACTOR;
    return this.taskAgents.get(parentToolUseId) ?? 'subagent';
  }

  private recordToolCall(actor: string, block: ToolUseBlock): void {
    const input = isRecord(block.input) ? block.input : {};
    const { target, label } = describeToolCall(block.name, input);
    this.trace.push({ from: actor, to: target, label, kind: 'call' });
    if (block.name === 'Task' && this.agentNames.includes(target)) {
      this.taskAgents.set(block.id, target);
      this.startedAt.set(block.id, this.now());
      this.invoked.add(target);
      this.onProgress?.({ type: 'agent-started', agent: target });
    } else {
      this.onProgress?.({ type: 'tool-call', actor, target, label });
    }
  }

  private recordTaskResult(block: ToolResultBlock): void {
    const agent = this.taskAgents.get(block.tool_use_id);
    if (!agent) return;
    const success = !block.is_error;
    if (success) this.completed.add(agent);
    this.trace.push({ from: agent, to: ORCHESTRATOR_ACTOR, label: success ? 'findings' : 'failed', kind: 'return' });
    const durationMs = this.now() - (this.startedAt.get(block.tool_use_id) ?? this.now());
    this.onProgress?.({ type: 'agent-completed', agent, success, durationMs });
  }
}
