import logger from './logger';

interface RateLimitWindow {
  count: number;
  resetTime: number;
}

/**
 * Simple rate limiter using sliding window algorithm
 */
export class RateLimiter {
  private windows: Map<string, RateLimitWindow> = new Map();
  private readonly limit: number;
  private readonly windowMs: number = 60 * 1000; // 1 minute

  constructor(limit: number = 60) {
    this.limit = limit;
  }

  /**
   * Check if the action is allowed for the given key
   * @param key - Identifier for the rate limit (e.g., room ID)
   * @returns true if allowed, false if rate limit exceeded
   */
  async checkLimit(key: string): Promise<boolean> {
    const now = Date.now();
    let window = this.windows.get(key);

    // Create new window or reset if expired
    if (!window || now >= window.resetTime) {
      window = {
        count: 0,
        resetTime: now + this.windowMs,
      };
      this.windows.set(key, window);
    }

    // Check if limit exceeded
    if (window.count >= this.limit) {
      logger.warn(`Rate limit exceeded for key: ${key}, count: ${window.count}/${this.limit}`);
      return false;
    }

    // Increment counter
    window.count++;
    return true;
  }

  /**
   * Reset rate limit for a specific key
   */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Clear all rate limit windows
   */
  clear(): void {
    this.windows.clear();
  }

  /**
   * Clean up expired windows (should be called periodically)
   */
  cleanup(): void {
    const now = Date.now();
    for (const [key, window] of this.windows.entries()) {
      if (now >= window.resetTime) {
        this.windows.delete(key);
      }
    }
  }
}

// Create singleton instance with default limit
export const rateLimiter = new RateLimiter(60);

// Clean up expired windows every 5 minutes
setInterval(() => {
  rateLimiter.cleanup();
}, 5 * 60 * 1000);
