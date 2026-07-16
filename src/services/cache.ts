// src/services/cache.ts
// Vendor-abstracted cache layer. Routes/services call this; this calls Redis.
// Swapping Upstash -> Redis Cloud/ElastiCache = zero changes here (same ioredis interface).
import type { Redis } from 'ioredis';

export class CacheService {
  constructor(private readonly redis: Redis) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys);
  }

  /** Delete every key matching a prefix (used for hierarchy/feed invalidation). */
  async delPrefix(prefix: string): Promise<void> {
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) await this.redis.del(...keys);
    } while (cursor !== '0');
  }

  /** Read-through helper. */
  async wrap<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key);
    if (hit !== null) return hit;
    const value = await loader();
    await this.set(key, value, ttlSeconds);
    return value;
  }
}

// Canonical cache keys + TTLs (single place, so invalidation stays honest).
export const cacheKeys = {
  hierarchyTree: 'hierarchy:tree',
  hierarchyChildren: (id: string) => `hierarchy:children:${id}`,
  trendingNodes: 'nodes:trending',
  userFeed: (userId: string, page: number, limit: number) => `feed:${userId}:${page}:${limit}`,
  node: (id: string) => `node:${id}`,
} as const;

export const cacheTtl = {
  hierarchyTree: 3600, // 1 hr per spec
  hierarchyChildren: 3600,
  trending: 300,
  feed: 60,
  node: 120,
} as const;
