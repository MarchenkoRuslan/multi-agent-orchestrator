import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCodes, ReviewError, withRetry, withTimeout } from '../src/utils/error-handler.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('retry and timeout', () => {
  it('retries with exponential delays and returns success', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const operation = vi.fn().mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary')).mockResolvedValue('ok');
    const pending = withRetry(operation, 2, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(operation).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('attempts once with zero retries and preserves cause', async () => {
    const cause = new Error('failed');
    const operation = vi.fn().mockRejectedValue(cause);
    await expect(withRetry(operation, 0)).rejects.toMatchObject({ code: ErrorCodes.RETRY_EXHAUSTED, cause });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry permanent validation errors', async () => {
    const operation = vi.fn().mockRejectedValue(new ReviewError('invalid', ErrorCodes.VALIDATION_FAILED));
    await expect(withRetry(operation)).rejects.toMatchObject({ code: ErrorCodes.VALIDATION_FAILED });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('lets callers veto retries per error and observe each retry', async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const shouldRetry = (error: unknown) => !(error instanceof ReviewError && error.code === ErrorCodes.AGENT_TIMEOUT);
    const timeout = new ReviewError('slow', ErrorCodes.AGENT_TIMEOUT);
    const operation = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockRejectedValue(timeout);
    const pending = withRetry(operation, 3, 100, { shouldRetry, onRetry });
    const assertion = expect(pending).rejects.toBe(timeout);
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'temporary' }), 1);
  });

  it('times out stalled work and cleans up timers', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(() => new Promise(() => {}), 100);
    const assertion = expect(pending).rejects.toMatchObject({ code: ErrorCodes.AGENT_TIMEOUT, metadata: { timeoutMs: 100 } });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears timers after success and synchronous failure', async () => {
    vi.useFakeTimers();
    expect(await withTimeout(async () => 42, 100)).toBe(42);
    await expect(withTimeout(() => { throw new Error('sync'); }, 100)).rejects.toThrow('sync');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid configuration', async () => {
    await expect(withRetry(async () => 1, -1)).rejects.toMatchObject({ code: ErrorCodes.INVALID_CONFIG });
    await expect(withTimeout(async () => 1, 0)).rejects.toMatchObject({ code: ErrorCodes.INVALID_CONFIG });
  });
});