import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter, withRateLimit } from '../src/utils/rate-limiter.js';

afterEach(() => vi.useRealTimers());

describe('sliding-window limiter', () => {
  it('never oversubscribes concurrent slots when waiters wake together', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    const first = await limiter.acquire();
    const second = limiter.acquire();
    const third = limiter.acquire();
    expect(limiter.getStatus().activeRequests).toBe(1);
    limiter.release(undefined, first);
    const secondId = await second;
    expect(limiter.getStatus().activeRequests).toBe(1);
    limiter.release(undefined, secondId);
    limiter.release(undefined, await third);
    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('expires request and token reservations at exactly 60 seconds', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ maxRequestsPerMinute: 1, maxTokensPerMinute: 1000 });
    limiter.release(undefined, await limiter.acquire(1000));
    const pending = limiter.acquire(1000);
    await vi.advanceTimersByTimeAsync(59999);
    expect(limiter.canProceed(1000)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const id = await pending;
    expect(limiter.getStatus().requestsInWindow).toBe(1);
    limiter.release(undefined, id);
  });

  it('accounts for out-of-order token usage and ignores duplicate release', async () => {
    const limiter = new RateLimiter();
    const first = await limiter.acquire(100);
    const second = await limiter.acquire(200);
    limiter.release(350, second);
    limiter.release(50, first);
    limiter.release(50, first);
    expect(limiter.getStatus()).toMatchObject({ activeRequests: 0, tokensInWindow: 400 });
  });

  it('releases only successfully acquired slots on failure', async () => {
    const limiter = new RateLimiter({ maxTokensPerMinute: 1000 });
    const active = await limiter.acquire(10);
    await expect(withRateLimit(limiter, async () => 1, 1001)).rejects.toThrow(RangeError);
    expect(limiter.getStatus().activeRequests).toBe(1);
    limiter.release(undefined, active);
    await expect(withRateLimit(limiter, async () => { throw new Error('failed'); }, 10)).rejects.toThrow('failed');
    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('rejects impossible budgets instead of waiting forever', async () => {
    expect(() => new RateLimiter({ maxConcurrent: 0 })).toThrow(RangeError);
    const limiter = new RateLimiter();
    await expect(limiter.acquire(-1)).rejects.toThrow(RangeError);
    await expect(limiter.acquire(Infinity)).rejects.toThrow(RangeError);
  });
});