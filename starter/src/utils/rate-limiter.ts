/**
 * Rate Limiter for API requests and token usage
 * Prevents exceeding Anthropic API rate limits
 *
 * This implements a token bucket algorithm with sliding window.
 *
 * Concepts:
 * - Tracks requests and tokens used in the last 60 seconds (sliding window)
 * - Limits concurrent requests to prevent overwhelming the API
 * - Uses token estimation to prevent exceeding token-per-minute limits
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  maxRequestsPerMinute: number;
  /** Maximum tokens per minute */
  maxTokensPerMinute: number;
  /** Maximum concurrent requests */
  maxConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,      // Conservative default
  maxTokensPerMinute: 100000,    // ~100k tokens/min
  maxConcurrent: 5               // Max parallel requests
};

interface RequestRecord {
  id: number;
  timestamp: number;
  tokens: number;
}

/**
 * Token bucket rate limiter with sliding window
 */
export class RateLimiter {
  private config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  private activeRequests: number = 0;
  private waitQueue: Array<() => void> = [];
  private activeRecords = new Map<number, RequestRecord>();
  private nextId = 0;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };
    if (Object.values(this.config).some(value => !Number.isSafeInteger(value) || value <= 0)) {
      throw new RangeError('Rate limits must be positive safe integers');
    }
  }

  /**
   * Wait until a request can be made within rate limits
   *
   * This is the main entry point for rate limiting.
   * It ensures:
   * 1. Concurrent request limit is not exceeded
   * 2. Request and token rate limits are respected
   * 3. The request is recorded for future rate limit calculations
   *
   * @param estimatedTokens - Estimated tokens for this request
   */
  async acquire(estimatedTokens: number = 1000): Promise<number> {
    this.validateTokens(estimatedTokens);
    while (!this.canProceed(estimatedTokens)) {
      if (this.activeRequests >= this.config.maxConcurrent) {
        await this.waitForSlot();
      } else {
        await this.waitForRateLimit(estimatedTokens);
      }
    }
    const record = { id: ++this.nextId, timestamp: Date.now(), tokens: estimatedTokens };
    this.activeRequests++;
    this.requestHistory.push(record);
    this.activeRecords.set(record.id, record);
    return record.id;
  }

  /**
   * Release a request slot after completion
   * @param actualTokens - Actual tokens used (updates estimate)
   */
  release(actualTokens?: number, requestId?: number): void {
    if (actualTokens !== undefined && (!Number.isSafeInteger(actualTokens) || actualTokens < 0)) {
      throw new RangeError('Actual token usage must be a nonnegative safe integer');
    }
    if (actualTokens !== undefined && requestId === undefined && this.activeRecords.size > 1) {
      throw new Error('A request ID is required to update concurrent token usage');
    }
    const id = requestId ?? this.activeRecords.keys().next().value;
    if (id === undefined) return;
    const record = this.activeRecords.get(id);
    if (!record) return;
    if (actualTokens !== undefined) record.tokens = actualTokens;
    this.activeRecords.delete(id);
    this.activeRequests--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /**
   * Get current rate limit status
   */
  getStatus(): {
    activeRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    availableRequests: number;
    availableTokens: number;
  } {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;
    const tokensInWindow = this.requestHistory.reduce((sum, r) => sum + r.tokens, 0);

    return {
      activeRequests: this.activeRequests,
      requestsInWindow,
      tokensInWindow,
      availableRequests: Math.max(0, this.config.maxRequestsPerMinute - requestsInWindow),
      availableTokens: Math.max(0, this.config.maxTokensPerMinute - tokensInWindow)
    };
  }

  /**
   * Check if request can proceed immediately
   *
   * @param estimatedTokens - Estimated tokens for the request
   * @returns true if the request can proceed without waiting
   */
  canProceed(estimatedTokens: number = 1000): boolean {
    this.validateTokens(estimatedTokens);
    this.pruneOldRecords();
    return this.activeRequests < this.config.maxConcurrent && this.hasRateCapacity(estimatedTokens);
  }

  private validateTokens(tokens: number): void {
    if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > this.config.maxTokensPerMinute) {
      throw new RangeError('Token estimate must fit within the configured per-minute budget');
    }
  }

  private hasRateCapacity(tokens: number): boolean {
    return this.requestHistory.length < this.config.maxRequestsPerMinute &&
      this.requestHistory.reduce((sum, record) => sum + record.tokens, 0) + tokens <= this.config.maxTokensPerMinute;
  }

  /**
   * Wait for a concurrent request slot to become available
   *
   * This creates a Promise that resolves when release() is called
   * and there's a queued waiter.
   */
  private async waitForSlot(): Promise<void> {
    await new Promise<void>(resolve => this.waitQueue.push(resolve));
  }

  /**
   * Wait until rate limits allow the request to proceed
   *
   * This implements the sliding window algorithm.
   * If we can't proceed immediately, we calculate how long to wait
   * until the oldest request expires (falls out of the 60-second window).
   *
   * @param estimatedTokens - Estimated tokens for the request
   */
  private async waitForRateLimit(estimatedTokens: number): Promise<void> {
    this.pruneOldRecords();
    while (!this.hasRateCapacity(estimatedTokens)) {
      const oldest = this.requestHistory[0];
      if (!oldest) return;
      const delay = Math.min(5000, Math.max(1, oldest.timestamp + 60000 - Date.now()));
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      this.pruneOldRecords();
    }
  }

  /**
   * Remove request records older than 60 seconds (sliding window)
   *
   * This is called before checking rate limits to ensure we only
   * count requests in the current 60-second window.
   */
  private pruneOldRecords(): void {
    const cutoff = Date.now() - 60000;
    this.requestHistory = this.requestHistory.filter(record => record.timestamp > cutoff);
  }
}

/**
 * Wrap an async function with rate limiting
 *
 * This is a convenience function for applying rate limiting to any async operation.
 */
export async function withRateLimit<T>(
  rateLimiter: RateLimiter,
  fn: () => Promise<T>,
  estimatedTokens: number = 1000
): Promise<T> {
  const requestId = await rateLimiter.acquire(estimatedTokens);
  try {
    return await fn();
  } finally {
    rateLimiter.release(undefined, requestId);
  }
}

// Global rate limiter instance
export const globalRateLimiter = new RateLimiter();