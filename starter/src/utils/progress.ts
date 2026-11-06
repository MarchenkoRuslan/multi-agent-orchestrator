import ora, { type Ora } from 'ora';
import type { ReviewProgressEvent } from './execution-tracker.js';
import { setConsoleLogging } from './logger.js';

const HEARTBEAT_MS = 30_000;
const TICK_MS = 1_000;

const formatSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Same rule ora uses to decide whether it may animate: a TTY that is not dumb and not CI. */
function isInteractive(stream: NodeJS.WritableStream): boolean {
  return Boolean((stream as NodeJS.WriteStream).isTTY) && process.env.TERM !== 'dumb' && !('CI' in process.env);
}

export interface ReviewProgressOptions {
  stream?: NodeJS.WritableStream;
  interactive?: boolean;
  now?: () => number;
}

/**
 * Terminal progress for one pull request review.
 * Interactive terminals get a spinner with the live "thinking" step and elapsed time.
 * Non-interactive output (pipes, CI) gets a line per agent start, tool call and finish, plus a periodic
 * heartbeat, so long-running subagents never look like a hung process.
 */
export class ReviewProgress {
  private readonly spinner: Ora;
  private readonly stream: NodeJS.WritableStream;
  private readonly interactive: boolean;
  private readonly now: () => number;
  private readonly finished = new Set<string>();
  private status: string;
  private startedAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly label: string,
    private readonly agentCount: number,
    options: ReviewProgressOptions = {}
  ) {
    this.stream = options.stream ?? process.stderr;
    this.interactive = options.interactive ?? isInteractive(this.stream);
    this.now = options.now ?? Date.now;
    this.status = `${label}: fetching PR snapshot via GitHub MCP`;
    this.spinner = ora({ text: this.status, stream: this.stream, isEnabled: this.interactive });
  }

  start(): void {
    setConsoleLogging(false);
    this.startedAt = this.now();
    this.spinner.start();
    this.timer = setInterval(() => this.tick(), this.interactive ? TICK_MS : HEARTBEAT_MS);
    this.timer.unref();
  }

  readonly handle = (event: ReviewProgressEvent): void => {
    switch (event.type) {
      case 'snapshot-ready':
        this.persist(`${this.label}: snapshot ready (${event.files} changed file(s)) - ${event.title}`);
        this.setStatus(`${this.prefix()} orchestrator delegating to specialist agents`);
        break;
      case 'agent-started':
        this.note(`${this.prefix()} ${event.agent} started`);
        this.setStatus(`${this.prefix()} ${event.agent} started`);
        break;
      case 'tool-call':
        if (!this.interactive) this.stream.write(`  ${event.actor} -> ${event.target}: ${event.label}\n`);
        this.setStatus(`${this.prefix()} ${event.actor} -> ${event.target}: ${event.label}`);
        break;
      case 'agent-completed':
        this.finished.add(event.agent);
        this.persist(`${this.prefix()} ${event.agent} ${event.success ? 'finished' : 'failed'} in ${formatSeconds(event.durationMs)}`,
          event.success);
        this.setStatus(this.finished.size < this.agentCount
          ? `${this.prefix()} waiting for remaining agents`
          : `${this.prefix()} orchestrator aggregating findings`);
        break;
      case 'aggregating':
        this.setStatus(`${this.prefix()} validating and aggregating the ReviewReport`);
        break;
      case 'retrying':
        this.persist(`${this.label}: analysis attempt failed, retrying (retry ${event.attempt}): ${event.reason}`, false);
        this.finished.clear();
        this.setStatus(`${this.prefix()} orchestrator delegating to specialist agents`);
        break;
    }
  };

  succeed(text: string): void {
    this.stopTimer();
    this.spinner.succeed(`${text} (${formatElapsed(this.elapsed())})`);
    setConsoleLogging(true);
  }

  fail(text: string): void {
    this.stopTimer();
    this.spinner.fail(`${text} (${formatElapsed(this.elapsed())})`);
    setConsoleLogging(true);
  }

  /** Text progress bar, e.g. "PR #2 [##-] 2/3 agents". */
  private prefix(): string {
    const done = Math.min(this.finished.size, this.agentCount);
    const bar = '#'.repeat(done) + '-'.repeat(this.agentCount - done);
    return `${this.label} [${bar}] ${done}/${this.agentCount} agents`;
  }

  private elapsed(): number {
    return this.now() - this.startedAt;
  }

  private tick(): void {
    if (this.interactive) this.render();
    else this.stream.write(`  ... still working, ${formatElapsed(this.elapsed())} elapsed: ${this.status}\n`);
  }

  private setStatus(text: string): void {
    this.status = text;
    if (!this.interactive) return;
    if (!this.spinner.isSpinning) this.spinner.start();
    this.render();
  }

  private render(): void {
    this.spinner.text = `${this.status} (${formatElapsed(this.elapsed())})`;
  }

  private note(text: string): void {
    if (this.interactive) {
      this.spinner.stopAndPersist({ symbol: '>', text });
      this.spinner.start();
    } else {
      this.stream.write(`> ${text}\n`);
    }
  }

  private persist(text: string, success = true): void {
    if (success) this.spinner.succeed(text);
    else this.spinner.fail(text);
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
