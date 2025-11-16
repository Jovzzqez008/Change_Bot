// rpcRateLimiter.ts - MEJORADO con backoff exponencial (TS + QuickNode friendly)

import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

export type RpcPriority = 'high' | 'medium' | 'low';

export interface RateLimiterConfig {
  maxPerSecond?: number | string;
  maxPerMinute?: number | string;
}

interface CacheEntry<T = unknown> {
  data: T;
  timestamp: number;
}

interface RequestCounters {
  second: number;
  minute: number;
  total: number;
  throttled: number;
}

interface ResetTimestamps {
  second: number;
  minute: number;
}

export class RPCRateLimiter {
  private readonly redis: RedisClient;
  private readonly maxRequestsPerSecond: number;
  private readonly maxRequestsPerMinute: number;

  private requestCount: RequestCounters;
  private lastReset: ResetTimestamps;

  private cache: Map<string, CacheEntry>;
  private cacheMaxAge: Record<RpcPriority, number>;

  private isThrottled: boolean;
  private throttleUntil: number;
  private backoffAttempts: number;

  constructor(config: RateLimiterConfig = {}) {
    if (!process.env.REDIS_URL) {
      throw new Error('Missing REDIS_URL for RPCRateLimiter');
    }

    this.redis = new RedisClass(process.env.REDIS_URL as string, {
      maxRetriesPerRequest: null,
    });

    // Límites conservadores; ajústalos con:
    // RPC_MAX_PER_SECOND / RPC_MAX_PER_MINUTE para tu QuickNode
    this.maxRequestsPerSecond = parseInt(
      String(config.maxPerSecond ?? process.env.RPC_MAX_PER_SECOND ?? '20'),
      10,
    );
    this.maxRequestsPerMinute = parseInt(
      String(config.maxPerMinute ?? process.env.RPC_MAX_PER_MINUTE ?? '800'),
      10,
    );

    const now = Date.now();
    this.requestCount = { second: 0, minute: 0, total: 0, throttled: 0 };
    this.lastReset = { second: now, minute: now };

    this.cache = new Map<string, CacheEntry>();
    this.cacheMaxAge = {
      high: parseInt(process.env.CACHE_HIGH_PRIORITY_MS ?? '2000', 10),
      medium: parseInt(process.env.CACHE_MEDIUM_PRIORITY_MS ?? '5000', 10),
      low: parseInt(process.env.CACHE_LOW_PRIORITY_MS ?? '10000', 10),
    };

    this.isThrottled = false;
    this.throttleUntil = 0;
    this.backoffAttempts = 0;

    this.startCleanup();

    console.log('🚦 RPC Rate Limiter (Conservative Mode, QuickNode-friendly)');
    console.log(
      `   Max: ${this.maxRequestsPerSecond}/s, ${this.maxRequestsPerMinute}/min`,
    );
    console.log(
      `   Cache: ${this.cacheMaxAge.high}ms (high) → ${this.cacheMaxAge.low}ms (low)`,
    );
  }

  /**
   * Envuelve llamadas RPC:
   *   await limiter.request(() => connection.getBalance(pubkey), 'high', cacheKey)
   */
  async request<T>(
    operation: () => Promise<T>,
    priority: RpcPriority = 'low',
    cacheKey?: string | null,
  ): Promise<T> {
    // 1. Cache primero
    if (cacheKey && this.cache.has(cacheKey)) {
      const cached = this.cache.get(cacheKey)!;
      const age = Date.now() - cached.timestamp;
      const maxAge =
        this.cacheMaxAge[priority] ?? this.cacheMaxAge.low;

      if (age < maxAge) {
        return cached.data as T;
      }
    }

    // 2. Throttle global si hubo 429
    if (this.isThrottled) {
      const waitTime = this.throttleUntil - Date.now();
      if (waitTime > 0) {
        console.log(
          `⏸️ Throttled, waiting ${(waitTime / 1000).toFixed(1)}s...`,
        );
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
      this.isThrottled = false;
    }

    // 3. Esperar un “slot” dentro del límite
    await this.waitForSlot();

    // 4. Ejecutar con reintentos
    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const result = await operation();

        // Éxito → reset backoff
        this.backoffAttempts = 0;
        this.incrementCounters();

        // Cachear resultado
        if (cacheKey && result !== undefined) {
          this.cache.set(cacheKey, {
            data: result,
            timestamp: Date.now(),
          });
        }

        return result;
      } catch (error: any) {
        lastError = error;

        // Rate limit 429
        if (this.is429Error(error)) {
          this.requestCount.throttled += 1;
          this.backoffAttempts += 1;

          const backoffMs = this.calculateBackoff();
          console.log(
            `⏸️ 429 Rate Limit (attempt ${attempt + 1}/${maxRetries})`,
          );
          console.log(
            `   Backing off for ${(backoffMs / 1000).toFixed(1)}s...`,
          );

          this.isThrottled = true;
          this.throttleUntil = Date.now() + backoffMs;

          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue; // retry
        }

        // Otros errores → solo reintentar si aún no es el último intento
        if (attempt === maxRetries - 1) {
          throw error;
        }

        await new Promise(resolve =>
          setTimeout(resolve, 1000 * (attempt + 1)),
        );
      }
    }

    throw lastError;
  }

  private is429Error(error: any): boolean {
    const msg = (error?.message ?? '').toLowerCase();
    return (
      msg.includes('429') ||
      msg.includes('rate limit') ||
      msg.includes('too many requests')
    );
  }

  private calculateBackoff(): number {
    // Backoff exponencial ~2s, 4s, 8s, 16s, hasta 30s + jitter
    const baseDelay = 2000;
    const maxDelay = 30000;

    const delay = Math.min(
      baseDelay * Math.pow(2, this.backoffAttempts),
      maxDelay,
    );

    const jitter = Math.random() * 1000;
    return delay + jitter;
  }

  private async waitForSlot(): Promise<void> {
    let now = Date.now();

    // Reset contadores
    if (now - this.lastReset.second >= 1000) {
      this.requestCount.second = 0;
      this.lastReset.second = now;
    }
    if (now - this.lastReset.minute >= 60_000) {
      this.requestCount.minute = 0;
      this.lastReset.minute = now;
    }

    let logged = false;
    // Esperar mientras estemos al límite
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (
        this.requestCount.second < this.maxRequestsPerSecond &&
        this.requestCount.minute < this.maxRequestsPerMinute
      ) {
        return;
      }

      if (!logged) {
        console.log(
          `⏳ Rate limit reached (${this.requestCount.second}/${this.maxRequestsPerSecond} per sec)`,
        );
        logged = true;
      }

      await new Promise(resolve => setTimeout(resolve, 200));

      now = Date.now();
      if (now - this.lastReset.second >= 1000) {
        this.requestCount.second = 0;
        this.lastReset.second = now;
      }
      if (now - this.lastReset.minute >= 60_000) {
        this.requestCount.minute = 0;
        this.lastReset.minute = now;
      }
    }
  }

  private incrementCounters(): void {
    this.requestCount.second += 1;
    this.requestCount.minute += 1;
    this.requestCount.total += 1;
  }

  private startCleanup(): void {
    const cacheTimer = setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, value] of this.cache.entries()) {
        // Limpiar cache >30s
        if (now - value.timestamp > 30_000) {
          this.cache.delete(key);
          cleaned += 1;
        }
      }

      if (cleaned > 0 || this.cache.size > 100) {
        console.log(
          `🧹 Cache: ${this.cache.size} items, cleaned ${cleaned}`,
        );
      }
    }, 60_000);

    (cacheTimer as any).unref?.();

    const statsTimer = setInterval(() => {
      if (this.requestCount.total > 0) {
        console.log(
          `📊 RPC Stats: ${this.requestCount.total} total, ${this.requestCount.throttled} throttled`,
        );
      }
    }, 300_000);

    (statsTimer as any).unref?.();
  }

  getStats() {
    return {
      requestsPerSecond: this.requestCount.second,
      requestsPerMinute: this.requestCount.minute,
      totalRequests: this.requestCount.total,
      throttledRequests: this.requestCount.throttled,
      cacheSize: this.cache.size,
      isThrottled: this.isThrottled,
      utilizationPercent: {
        second: (
          (this.requestCount.second / this.maxRequestsPerSecond) *
          100
        ).toFixed(1),
        minute: (
          (this.requestCount.minute / this.maxRequestsPerMinute) *
          100
        ).toFixed(1),
      },
    };
  }
}

// Singleton para usar en todo el proyecto
let rateLimiterInstance: RPCRateLimiter | null = null;

export function getRateLimiter(): RPCRateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RPCRateLimiter();
  }
  return rateLimiterInstance;
}
