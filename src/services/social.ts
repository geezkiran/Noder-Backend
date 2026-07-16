// src/services/social.ts
// Votes, bookmarks, follows (user OR hierarchy branch), and public profiles.
import type { Sql } from 'postgres';
import { badRequest, conflict, notFound } from '../utils/envelope.js';

export class SocialService {
  constructor(private readonly sql: Sql) {}

  /** value: 1 upvote, -1 downvote, 0 clear. Returns the node's new vote_count. */
  async vote(userId: string, nodeId: string, value: 1 | -1 | 0): Promise<{ vote_count: number }> {
    const [node] = await this.sql<Array<{ id: string; author_id: string }>>`
      SELECT id, author_id FROM nodes WHERE id = ${nodeId} AND deleted_at IS NULL
    `;
    if (!node) throw notFound('Node');
    if (node.author_id === userId && value !== 0) {
      throw badRequest('You cannot vote on your own node');
    }

    if (value === 0) {
      await this.sql`DELETE FROM votes WHERE user_id = ${userId} AND node_id = ${nodeId}`;
    } else {
      await this.sql`
        INSERT INTO votes (user_id, node_id, value)
        VALUES (${userId}, ${nodeId}, ${value})
        ON CONFLICT (user_id, node_id) DO UPDATE SET value = ${value}
      `;
      // Reputation: author gains/loses with votes (simple v1 heuristic).
      await this.sql`
        UPDATE users SET reputation = greatest(reputation + ${value}, 0)
        WHERE id = ${node.author_id}
      `;
    }

    const [after] = await this.sql<[{ vote_count: number }]>`
      SELECT vote_count FROM nodes WHERE id = ${nodeId}
    `;
    return { vote_count: after?.vote_count ?? 0 };
  }

  async bookmark(userId: string, nodeId: string, on: boolean): Promise<void> {
    const [node] = await this.sql`SELECT id FROM nodes WHERE id = ${nodeId} AND deleted_at IS NULL`;
    if (!node) throw notFound('Node');
    if (on) {
      await this.sql`
        INSERT INTO bookmarks (user_id, node_id) VALUES (${userId}, ${nodeId})
        ON CONFLICT DO NOTHING
      `;
    } else {
      await this.sql`DELETE FROM bookmarks WHERE user_id = ${userId} AND node_id = ${nodeId}`;
    }
  }

  async follow(
    followerId: string,
    targetType: 'user' | 'hierarchy',
    targetId: string,
  ): Promise<{ id: string }> {
    if (targetType === 'user') {
      if (targetId === followerId) throw badRequest('You cannot follow yourself');
      const [target] = await this.sql`SELECT id FROM users WHERE id = ${targetId}`;
      if (!target) throw notFound('User');
      const [existing] = await this.sql`
        SELECT id FROM follows
        WHERE follower_id = ${followerId} AND target_type = 'user' AND target_user_id = ${targetId}
      `;
      if (existing) throw conflict('Already following this user');
      const [row] = await this.sql<Array<{ id: string }>>`
        INSERT INTO follows (follower_id, target_type, target_user_id)
        VALUES (${followerId}, 'user', ${targetId})
        RETURNING id
      `;
      if (!row) throw new Error('Failed to follow');
      return row;
    }

    const [target] = await this.sql`
      SELECT id FROM hierarchy_nodes WHERE id = ${targetId} AND status = 'approved'
    `;
    if (!target) throw notFound('Hierarchy node');
    const [existing] = await this.sql`
      SELECT id FROM follows
      WHERE follower_id = ${followerId} AND target_type = 'hierarchy' AND target_hierarchy_id = ${targetId}
    `;
    if (existing) throw conflict('Already following this branch');
    const [row] = await this.sql<Array<{ id: string }>>`
      INSERT INTO follows (follower_id, target_type, target_hierarchy_id)
      VALUES (${followerId}, 'hierarchy', ${targetId})
      RETURNING id
    `;
    if (!row) throw new Error('Failed to follow');
    return row;
  }

  async unfollow(
    followerId: string,
    targetType: 'user' | 'hierarchy',
    targetId: string,
  ): Promise<void> {
    const result =
      targetType === 'user'
        ? await this.sql`
            DELETE FROM follows
            WHERE follower_id = ${followerId} AND target_type = 'user' AND target_user_id = ${targetId}
          `
        : await this.sql`
            DELETE FROM follows
            WHERE follower_id = ${followerId} AND target_type = 'hierarchy' AND target_hierarchy_id = ${targetId}
          `;
    if (result.count === 0) throw notFound('Follow');
  }

  async profile(userId: string): Promise<Record<string, unknown>> {
    const [user] = await this.sql`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio, u.role, u.reputation,
             u.created_at,
             (SELECT count(*)::int FROM nodes n WHERE n.author_id = u.id AND n.deleted_at IS NULL) AS node_count,
             (SELECT count(*)::int FROM follows f WHERE f.target_user_id = u.id AND f.target_type = 'user') AS follower_count,
             (SELECT count(*)::int FROM follows f WHERE f.follower_id = u.id) AS following_count,
             (SELECT coalesce(sum(n.vote_count), 0)::int FROM nodes n WHERE n.author_id = u.id AND n.deleted_at IS NULL) AS total_votes
      FROM users u WHERE u.id = ${userId}
    `;
    if (!user) throw notFound('User');
    return user;
  }
}
