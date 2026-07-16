// src/services/feed.ts
// Personalized feed (followed users + followed hierarchy branches, subtree semantics),
// hierarchy subtree feed, and trending — the hot paths, so both feed and trending cache in Redis.
import type { Sql } from 'postgres';
import type { NodeCard } from '../types/index.js';
import type { CacheService } from './cache.js';
import { cacheKeys, cacheTtl } from './cache.js';
import { notFound } from '../utils/envelope.js';

const CARD_SELECT = `
  n.id, n.author_id, n.hierarchy_node_id, n.title, n.summary, n.cover_image,
  n.hierarchy_path, n.vote_count, n.bookmark_count, n.relation_count,
  n.x, n.y, n.created_at, n.updated_at
`;

export class FeedService {
  constructor(
    private readonly sql: Sql,
    private readonly cache: CacheService,
  ) {}

  /** Feed from followed users + followed hierarchy branches (including sub-branches). */
  async personalized(
    userId: string,
    page: number,
    limit: number,
  ): Promise<{ items: NodeCard[]; total: number }> {
    return this.cache.wrap(cacheKeys.userFeed(userId, page, limit), cacheTtl.feed, async () => {
      const offset = (page - 1) * limit;

      const filter = this.sql`
        n.deleted_at IS NULL AND (
          n.author_id IN (
            SELECT f.target_user_id FROM follows f
            WHERE f.follower_id = ${userId} AND f.target_type = 'user'
          )
          OR EXISTS (
            SELECT 1
            FROM follows f
            JOIN hierarchy_nodes fh ON fh.id = f.target_hierarchy_id
            JOIN hierarchy_nodes nh ON nh.id = n.hierarchy_node_id
            WHERE f.follower_id = ${userId} AND f.target_type = 'hierarchy'
              AND (nh.path = fh.path OR nh.path LIKE fh.path || '/%')
          )
        )
      `;

      const items = await this.sql<NodeCard[]>`
        SELECT ${this.sql.unsafe(CARD_SELECT)}
        FROM nodes n
        WHERE ${filter}
        ORDER BY n.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      const [{ total }] = await this.sql<[{ total: number }]>`
        SELECT count(*)::int AS total FROM nodes n WHERE ${filter}
      `;

      return { items: [...items], total };
    });
  }

  /** All nodes under a hierarchy subtree, newest first. */
  async hierarchyFeed(
    hierarchyId: string,
    page: number,
    limit: number,
  ): Promise<{ items: NodeCard[]; total: number }> {
    const [h] = await this.sql<Array<{ path: string }>>`
      SELECT path FROM hierarchy_nodes WHERE id = ${hierarchyId} AND status = 'approved'
    `;
    if (!h) throw notFound('Hierarchy node');

    const offset = (page - 1) * limit;

    const filter = this.sql`
      n.deleted_at IS NULL AND EXISTS (
        SELECT 1 FROM hierarchy_nodes nh
        WHERE nh.id = n.hierarchy_node_id
          AND (nh.path = ${h.path} OR nh.path LIKE ${h.path + '/%'})
      )
    `;

    const items = await this.sql<NodeCard[]>`
      SELECT ${this.sql.unsafe(CARD_SELECT)}
      FROM nodes n
      WHERE ${filter}
      ORDER BY n.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ total }] = await this.sql<[{ total: number }]>`
      SELECT count(*)::int AS total FROM nodes n WHERE ${filter}
    `;

    return { items: [...items], total };
  }

  /** Trending: score = votes weighted by recency over the last 7 days. Cached 5 min. */
  async trending(limit: number): Promise<NodeCard[]> {
    const cached = await this.cache.wrap(cacheKeys.trendingNodes, cacheTtl.trending, async () => {
      const rows = await this.sql<NodeCard[]>`
        SELECT ${this.sql.unsafe(CARD_SELECT)}
        FROM nodes n
        WHERE n.deleted_at IS NULL
          AND n.created_at >= now() - interval '7 days'
        ORDER BY (n.vote_count + 1) / power(extract(epoch FROM now() - n.created_at) / 3600 + 2, 1.5) DESC
        LIMIT 50
      `;
      return [...rows];
    });
    return cached.slice(0, limit);
  }
}
