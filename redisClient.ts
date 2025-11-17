import { Redis as RedisClass } from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';

let sharedInstance: RedisClient | null = null;

export type { RedisClient };

export function createRedisClient(): RedisClient {
  if (sharedInstance) {
    return sharedInstance;
  }

  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('Missing REDIS_URL environment variable');
  }

  sharedInstance = new RedisClass(url, { maxRetriesPerRequest: null });
  return sharedInstance;
}
