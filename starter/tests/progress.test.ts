import { afterEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { ReviewProgress } from '../src/utils/progress.js';

function capture(): { stream: PassThrough; output: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', chunk => { text += String(chunk); });
  return { stream, output: () => text };
}

afterEach(() => { vi.useRealTimers(); });

describe('ReviewProgress', () => {
  it('prints agent starts, tool calls and a progress-bar line as each subagent completes', () => {
    const { stream, output } = capture();
    let clock = 0;
    const progress = new ReviewProgress('PR #2', 3, { stream, interactive: false, now: () => clock });

    progress.start();
    progress.handle({ type: 'snapshot-ready', files: 1, title: 'Add search' });
    progress.handle({ type: 'agent-started', agent: 'code-quality-analyzer' });
    progress.handle({ type: 'tool-call', actor: 'code-quality-analyzer', target: 'ESLint MCP', label: 'lint-files' });
    progress.handle({ type: 'agent-completed', agent: 'code-quality-analyzer', success: true, durationMs: 2_000 });
    progress.handle({ type: 'agent-completed', agent: 'test-coverage-analyzer', success: false, durationMs: 500 });
    progress.handle({ type: 'aggregating' });
    clock = 75_000;
    progress.succeed('PR #2: review complete');

    const text = output();
    expect(text).toContain('PR #2: snapshot ready (1 changed file(s)) - Add search');
    expect(text).toContain('> PR #2 [---] 0/3 agents code-quality-analyzer started');
    expect(text).toContain('  code-quality-analyzer -> ESLint MCP: lint-files');
    expect(text).toContain('PR #2 [#--] 1/3 agents code-quality-analyzer finished in 2.0s');
    expect(text).toContain('PR #2 [##-] 2/3 agents test-coverage-analyzer failed in 0.5s');
    expect(text).toContain('PR #2: review complete (1m 15s)');
    expect(text.match(/agents code-quality-analyzer started/g)).toHaveLength(1);
  });

  it('prints a failure line and resets the agent bar when the orchestrator retries', () => {
    const { stream, output } = capture();
    const progress = new ReviewProgress('PR #3', 3, { stream, interactive: false });
    progress.start();
    progress.handle({ type: 'agent-completed', agent: 'code-quality-analyzer', success: true, durationMs: 1_000 });
    progress.handle({ type: 'retrying', attempt: 1, reason: 'socket hang up' });
    progress.handle({ type: 'agent-started', agent: 'code-quality-analyzer' });
    progress.fail('PR #3: review failed');
    expect(output()).toContain('PR #3: analysis attempt failed, retrying (retry 1): socket hang up');
    expect(output()).toContain('> PR #3 [---] 0/3 agents code-quality-analyzer started');
  });

  it('prints a heartbeat in non-interactive output so long agent runs do not look hung', () => {
    vi.useFakeTimers();
    const { stream, output } = capture();
    const progress = new ReviewProgress('PR #1', 3, { stream, interactive: false, now: () => Date.now() });
    progress.start();
    progress.handle({ type: 'agent-started', agent: 'refactoring-suggester' });
    vi.advanceTimersByTime(60_000);
    progress.succeed('PR #1: review complete');
    vi.advanceTimersByTime(60_000);

    const heartbeats = output().match(/\.\.\. still working, [\dms ]+ elapsed/g) ?? [];
    expect(heartbeats).toEqual(['... still working, 30s elapsed', '... still working, 1m 00s elapsed']);
    expect(output()).toContain('elapsed: PR #1 [---] 0/3 agents refactoring-suggester started');
  });
});
