import { afterEach, describe, expect, it, vi } from 'vitest';
import type { query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { agents, CodeReviewOrchestrator } from '../src/orchestrator.js';
import { safeSnapshotPath, type PullRequestSnapshot } from '../src/mcp/snapshot.js';
import { validReport } from './fixtures/review-report.js';

const snapshot: PullRequestSnapshot = { directory: '/snapshot', title: 'Search todos', url: 'https://github.com/udacity/cd14715-simple-todo-app/pull/2',
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), supportingFiles: [],
  files: [{ file: 'src/search.ts', status: 'added', lineCount: 20, localPath: '/snapshot/source/src/search.ts' }] };

function fakeQuery(output: unknown = validReport, names = Object.keys(agents)) {
  const close = vi.fn().mockResolvedValue({ done: true, value: undefined });
  const execute = vi.fn(() => Object.assign((async function* () {
    yield { type: 'assistant', message: { content: names.map(name => ({ type: 'tool_use', name: 'Task', id: name,
      input: { subagent_type: name } })) } } as unknown as SDKMessage;
    yield { type: 'user', message: { content: names.map(name => ({ type: 'tool_result', tool_use_id: name, content: 'Analysis completed', is_error: false })) } } as unknown as SDKMessage;
    yield { type: 'result', subtype: 'success', is_error: false, structured_output: structuredClone(output),
      usage: { input_tokens: 100, output_tokens: 100 } } as unknown as SDKMessage;
  })(), { return: close }));
  return { queryFn: execute as unknown as typeof query, execute, close };
}

afterEach(() => vi.useRealTimers());

describe('CodeReviewOrchestrator', () => {
  it('initializes with default and custom rate limits', () => {
    expect(new CodeReviewOrchestrator().rateLimiter.getStatus().availableRequests).toBe(50);
    expect(new CodeReviewOrchestrator({ rateLimits: { maxRequestsPerMinute: 2 } }).rateLimiter.getStatus().availableRequests).toBe(2);
  });

  it('fetches a pinned MCP snapshot and registers all three least-privilege agents', async () => {
    const fake = fakeQuery();
    const loader = vi.fn().mockResolvedValue(snapshot);
    const orchestrator = new CodeReviewOrchestrator({ model: 'test-model', maxRetries: 0, queryFn: fake.queryFn, snapshotLoader: loader });
    const report = await orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);
    expect(loader).toHaveBeenCalledWith('udacity', 'cd14715-simple-todo-app', 2, expect.any(String));
    const config = fake.execute.mock.calls[0] as unknown as [{ options: Record<string, unknown>; prompt: string }];
    expect(config[0].options).toMatchObject({ agents, settingSources: ['project'],
      tools: ['Task', 'Read', 'Grep', 'Glob', 'Skill'], outputFormat: { type: 'json_schema' } });
    expect(config[0].options).toMatchObject({ env: { MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '120000' },
      mcpServers: { eslint: { command: 'npx', env: { npm_config_prefer_offline: 'true' } } } });
    expect(config[0].prompt).toContain('parallel');
    const permission = config[0].options.canUseTool as (name: string, input: Record<string, unknown>) => Promise<{ behavior: string }>;
    expect(await permission('mcp__github__create_issue', {})).toMatchObject({ behavior: 'deny' });
    expect(await permission('Read', { file_path: '/snapshot/source/src/search.ts' })).toMatchObject({ behavior: 'allow' });
    for (const agent of Object.values(agents)) {
      expect(agent.model).toBe('inherit');
      expect(agent.tools).toContain('Skill');
      expect(agent.tools).not.toContain('Bash');
    }
    expect(report.summary).toMatchObject({ totalFiles: 1, overallScore: 85, highPriorityTests: 1, refactoringOpportunities: 1 });
    expect(Object.keys(report.metadata.agentVersions)).toEqual(Object.keys(agents));
    expect(orchestrator.rateLimiter.getStatus().activeRequests).toBe(0);
    expect(fake.close).toHaveBeenCalled();
  });

  it('reports live progress and stores a host-recorded execution trace in the report', async () => {
    const fake = fakeQuery();
    const events: Array<{ type: string; agent?: string }> = [];
    const report = await new CodeReviewOrchestrator({ model: 'test', maxRetries: 0, queryFn: fake.queryFn,
      snapshotLoader: async () => snapshot, onProgress: event => events.push(event) })
      .reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);
    expect(events.map(event => event.type)).toEqual(['snapshot-ready', 'agent-started', 'agent-started', 'agent-started',
      'agent-completed', 'agent-completed', 'agent-completed', 'aggregating']);
    expect(events.filter(event => event.type === 'agent-completed').map(event => event.agent)).toEqual(Object.keys(agents));
    const trace = report.metadata.executionTrace ?? [];
    expect(trace.filter(event => event.kind === 'call')).toEqual(Object.keys(agents).map(name =>
      ({ from: 'orchestrator', to: name, label: 'Task', kind: 'call' })));
    expect(trace.filter(event => event.kind === 'return').map(event => event.from)).toEqual(Object.keys(agents));
  });

  it('recalculates scores and counts instead of trusting model arithmetic', async () => {
    const output = structuredClone(validReport);
    output.fileReviews[0]!.codeQuality.overallScore = 100;
    output.summary.overallScore = 99;
    output.summary.totalFiles = 99;
    const fake = fakeQuery(output);
    const report = await new CodeReviewOrchestrator({ model: 'test', maxRetries: 0, queryFn: fake.queryFn,
      snapshotLoader: async () => snapshot }).reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);
    expect(report.summary.overallScore).toBe(85);
    expect(report.summary.totalFiles).toBe(1);
  });

  it.each([{}, { ...validReport, fileReviews: [] },
    { ...validReport, pullRequest: { ...validReport.pullRequest, number: 3 } }])('rejects invalid structured output or incomplete evidence', async output => {
    const fake = fakeQuery(output);
    await expect(new CodeReviewOrchestrator({ model: 'test', maxRetries: 0, queryFn: fake.queryFn,
      snapshotLoader: async () => snapshot }).reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2))
      .rejects.toMatchObject({ code: 'RETRY_EXHAUSTED', cause: { code: 'STRUCTURED_OUTPUT_FAILED' } });
  });

  it('rejects a fabricated successful report when a specialist was never invoked', async () => {
    const fake = fakeQuery(validReport, ['code-quality-analyzer']);
    await expect(new CodeReviewOrchestrator({ model: 'test', maxRetries: 0, queryFn: fake.queryFn,
      snapshotLoader: async () => snapshot }).reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2))
      .rejects.toMatchObject({ code: 'RETRY_EXHAUSTED', cause: { code: 'AGENT_FAILED' } });
  });

  it('rejects out-of-range issue lines', async () => {
    const output = structuredClone(validReport);
    output.fileReviews[0]!.codeQuality.issues[0]!.line = 100;
    const fake = fakeQuery(output);
    await expect(new CodeReviewOrchestrator({ model: 'test', maxRetries: 0, queryFn: fake.queryFn,
      snapshotLoader: async () => snapshot }).reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2))
      .rejects.toMatchObject({ cause: { code: 'STRUCTURED_OUTPUT_FAILED' } });
  });

  it('aborts a stalled SDK session, releases its reservation, and does not retry the timeout', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const close = vi.fn().mockResolvedValue({ done: true, value: undefined });
    const queryFn = vi.fn((args: { options: { abortController: AbortController } }) => {
      signal = args.options.abortController.signal;
      return Object.assign((async function* () { await new Promise(() => {}); })(), { return: close });
    });
    const orchestrator = new CodeReviewOrchestrator({ model: 'test', maxRetries: 1, timeoutMs: 100,
      queryFn: queryFn as unknown as typeof query, snapshotLoader: async () => snapshot });
    const pending = orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'AGENT_TIMEOUT',
      message: expect.stringContaining('REVIEW_TIMEOUT_MINUTES') });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(orchestrator.rateLimiter.getStatus().activeRequests).toBe(0);
  });

  it('reports a retry through onProgress when an analysis attempt fails transiently', async () => {
    const events: Array<{ type: string; attempt?: number }> = [];
    let calls = 0;
    const good = fakeQuery();
    const queryFn = ((args: Parameters<typeof query>[0]) => {
      calls += 1;
      if (calls === 1) return Object.assign((async function* () { throw new Error('socket hang up'); })(),
        { return: vi.fn().mockResolvedValue({ done: true, value: undefined }) });
      return good.queryFn(args);
    }) as typeof query;
    await new CodeReviewOrchestrator({ model: 'test', maxRetries: 1, queryFn, snapshotLoader: async () => snapshot,
      onProgress: event => events.push(event) }).reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2);
    expect(events.find(event => event.type === 'retrying')).toMatchObject({ attempt: 1, reason: expect.stringContaining('socket hang up') });
  });

  it('rejects invalid PR arguments before fetching anything', async () => {
    const loader = vi.fn();
    await expect(new CodeReviewOrchestrator({ snapshotLoader: loader }).reviewPullRequest('../bad', 'repo', 0))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('releases its reservation if SDK session creation throws synchronously', async () => {
    const queryFn = vi.fn(() => { throw new Error('SDK startup failed'); }) as unknown as typeof query;
    const orchestrator = new CodeReviewOrchestrator({ model: 'test', maxRetries: 0, queryFn,
      snapshotLoader: async () => snapshot });
    await expect(orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2)).rejects.toMatchObject({ code: 'RETRY_EXHAUSTED' });
    expect(orchestrator.rateLimiter.getStatus().activeRequests).toBe(0);
  });

  it('does not retry permanently rejected provider credentials', async () => {
    const queryFn = vi.fn(() => Object.assign((async function* () {
      yield { type: 'result', subtype: 'success', is_error: true,
        result: 'API Error: 400 Key access is suspended.' } as unknown as SDKMessage;
    })(), { return: vi.fn().mockResolvedValue({ done: true, value: undefined }) })) as unknown as typeof query;
    const orchestrator = new CodeReviewOrchestrator({ model: 'test', queryFn, snapshotLoader: async () => snapshot });
    await expect(orchestrator.reviewPullRequest('udacity', 'cd14715-simple-todo-app', 2)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(queryFn).toHaveBeenCalledTimes(1);
    expect(orchestrator.rateLimiter.getStatus().activeRequests).toBe(0);
  });

  it('rejects repository paths that escape the snapshot', () => {
    for (const file of ['../secret', '/secret', 'C:\\secret', 'nested/../../secret']) {
      expect(() => safeSnapshotPath('/snapshot', file)).toThrow();
    }
  });

  it.runIf(process.env.RUN_LIVE_REVIEW === '1')('analyzes a real public PR through GitHub MCP and Claude', async () => {
    // Integration case: fetches a real PR over the GitHub MCP snapshot server and runs all three subagents.
    // Run with RUN_LIVE_REVIEW=1 (needs ANTHROPIC_API_KEY, ANTHROPIC_MODEL, PROJECT_ROOT; GITHUB_TOKEN recommended).
    // LIVE_REVIEW_PR=octocat/Hello-World/1 targets the classic public sample PR instead of the assignment repo.
    const [owner, repo, number] = (process.env.LIVE_REVIEW_PR ?? 'udacity/cd14715-simple-todo-app/1').split('/');
    const report = await new CodeReviewOrchestrator().reviewPullRequest(owner!, repo!, Number(number));
    expect(report.fileReviews.length).toBeGreaterThan(0);
    expect(Object.keys(report.metadata.agentVersions)).toHaveLength(3);
    expect(report.metadata.executionTrace?.some(event => event.label === 'Task')).toBe(true);
  }, 1200000);
});
