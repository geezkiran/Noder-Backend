// src/services/search.ts
// Full-text search over title (weight A) + summary (weight B) tsvector,
// optionally scoped to a hierarchy subtree.
import type { Sql } from 'postgres';
import type { NodeCard } from '../types/index.js';
import { notFound } from '../utils/envelope.js';

export class SearchService {
  constructor(private readonly sql: Sql) {}

  async search(
    q: string,
    hierarchyId: string | undefined,
    page: number,
    limit: number,
  ): Promise<{ items: Array<NodeCard & { rank: number }>; total: number }> {
    let pathPrefix: string | null = null;
    if (hierarchyId) {
      const [h] = await this.sql<Array<{ path: string }>>`
        SELECT path FROM hierarchy_nodes WHERE id = ${hierarchyId}
      `;
      if (!h) throw notFound('Hierarchy node');
      pathPrefix = h.path;
    }

    const offset = (page - 1) * limit;

    const filter = this.sql`
      n.deleted_at IS NULL
      AND n.tsv @@ websearch_to_tsquery('english', ${q})
      AND (${pathPrefix}::text IS NULL OR EXISTS (
        SELECT 1 FROM hierarchy_nodes h
        WHERE h.id = n.hierarchy_node_id
          AND (h.path = ${pathPrefix} OR h.path LIKE ${(pathPrefix ?? '') + '/%'})
      ))
    `;

    const items = await this.sql<Array<NodeCard & { rank: number }>>`
      SELECT n.id, n.author_id, n.hierarchy_node_id, n.title, n.summary, n.cover_image,
             n.hierarchy_path, n.vote_count, n.bookmark_count, n.relation_count,
             n.x, n.y, n.created_at, n.updated_at,
             ts_rank(n.tsv, websearch_to_tsquery('english', ${q}))::float AS rank
      FROM nodes n
      WHERE ${filter}
      ORDER BY rank DESC, n.vote_count DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const [{ total }] = await this.sql<[{ total: number }]>`
      SELECT count(*)::int AS total FROM nodes n WHERE ${filter}
    `;

    return { items: [...items], total };
  }
}
