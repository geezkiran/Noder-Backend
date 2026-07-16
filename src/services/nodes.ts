// src/services/nodes.ts
// Node (post) lifecycle: create with fixed map position + inline-link extraction,
// read, update, soft delete, list/filter. Embedding + rebalance happen async via queue.
import type { Sql } from 'postgres';
import type { NodeBlock, NodeCard, NodeFull, TextBlock } from '../types/index.js';
import type { CreateNodeInput, ListNodesQuery, UpdateNodeInput } from '../schemas/nodes.js';
import type { CacheService } from './cache.js';
import { cacheKeys, cacheTtl } from './cache.js';
import { LayoutService, REBALANCE_THRESHOLD } from './layout.js';
import type { QueueService } from './queue.js';
import { badRequest, forbidden, notFound } from '../utils/envelope.js';

const INLINE_LINK_RE = /\[\[node:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]\]/g;

const CARD_COLUMNS = `
  id, author_id, hierarchy_node_id, title, summary, cover_image, hierarchy_path,
  vote_count, bookmark_count, relation_count, x, y, created_at, updated_at
`;

/** Parse [[node:uuid]] syntax in text blocks -> inline_links arrays + flat id list. */
export function extractInlineLinks(body: NodeBlock[]): {
  body: NodeBlock[];
  linkedIds: string[];
} {
  const linkedIds = new Set<string>();
  const processed = body.map((block) => {
    if (block.type !== 'text') return block;
    const links: TextBlock['inline_links'] = [];
    for (const match of block.content.matchAll(INLINE_LINK_RE)) {
      const nodeId = match[1];
      if (nodeId) {
        linkedIds.add(nodeId);
        links.push({ node_id: nodeId, display_text: `node:${nodeId}` });
      }
    }
    return { ...block, inline_links: links };
  });
  return { body: processed, linkedIds: [...linkedIds] };
}

export class NodeService {
  private readonly layout: LayoutService;

  constructor(
    private readonly sql: Sql,
    private readonly cache: CacheService,
    private readonly queue: QueueService,
  ) {
    this.layout = new LayoutService(sql);
  }

  private async syncInlineLinks(tx: Sql, nodeId: string, linkedIds: string[]): Promise<void> {
    await tx`DELETE FROM node_inline_links WHERE from_node_id = ${nodeId}`;
    if (linkedIds.length === 0) return;
    // Only link to nodes that actually exist; dangling [[node:...]] refs are ignored.
    await tx`
      INSERT INTO node_inline_links (from_node_id, to_node_id)
      SELECT ${nodeId}, id FROM nodes
      WHERE id = ANY(${linkedIds}::uuid[]) AND id <> ${nodeId} AND deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `;
  }

  private async syncTags(tx: Sql, nodeId: string, tags: string[]): Promise<void> {
    await tx`DELETE FROM node_tags WHERE node_id = ${nodeId}`;
    for (const raw of tags) {
      const name = raw.trim().toLowerCase();
      if (!name) continue;
      const [tag] = await tx<Array<{ id: string }>>`
        WITH ins AS (
          INSERT INTO tags (name) VALUES (${name})
          ON CONFLICT (lower(name)) DO NOTHING
          RETURNING id
        )
        SELECT id FROM ins
        UNION ALL
        SELECT id FROM tags WHERE lower(name) = ${name}
        LIMIT 1
      `;
      if (tag) {
        await tx`INSERT INTO node_tags (node_id, tag_id) VALUES (${nodeId}, ${tag.id}) ON CONFLICT DO NOTHING`;
      }
    }
  }

  async create(authorId: string, input: CreateNodeInput): Promise<NodeFull> {
    const [hierarchy] = await this.sql<
      Array<{ id: string; path: string; node_count: number; status: string }>
    >`SELECT id, path, node_count, status FROM hierarchy_nodes WHERE id = ${input.hierarchy_node_id}`;
    if (!hierarchy) throw notFound('Hierarchy node');
    if (hierarchy.status !== 'approved') throw badRequest('Cannot post to an unapproved branch');

    // Display chain, e.g. ['Programming','Python','Decorators'].
    const chain = await this.sql<Array<{ name: string }>>`
      WITH RECURSIVE up AS (
        SELECT id, parent_id, name, depth FROM hierarchy_nodes WHERE id = ${hierarchy.id}
        UNION ALL
        SELECT h.id, h.parent_id, h.name, h.depth FROM hierarchy_nodes h JOIN up ON h.id = up.parent_id
      )
      SELECT name FROM up ORDER BY depth
    `;
    const hierarchyPath = chain.map((c) => c.name);

    const { body, linkedIds } = extractInlineLinks(input.body);
    const pos = await this.layout.placeNode(hierarchy.id);

    const node = await this.sql.begin(async (tx) => {
      const [row] = await tx<NodeFull[]>`
        INSERT INTO nodes (author_id, hierarchy_node_id, title, summary, cover_image, body,
                           hierarchy_path, x, y)
        VALUES (${authorId}, ${hierarchy.id}, ${input.title}, ${input.summary ?? null},
                ${input.cover_image ?? null}, ${tx.json(body as never)}, ${hierarchyPath},
                ${pos.x}, ${pos.y})
        RETURNING ${tx.unsafe(CARD_COLUMNS)}, body
      `;
      if (!row) throw new Error('Failed to insert node');
      await this.syncInlineLinks(tx as unknown as Sql, row.id, linkedIds);
      await this.syncTags(tx as unknown as Sql, row.id, input.tags);
      return row;
    });

    await this.queue.enqueueEmbedding(node.id);
    if (hierarchy.node_count + 1 > REBALANCE_THRESHOLD) {
      await this.queue.enqueueRebalance(hierarchy.id);
    }
    await this.cache.del(cacheKeys.trendingNodes);

    return node;
  }

  async getById(id: string): Promise<NodeFull & { author_username: string; tags: string[] }> {
    const [row] = await this.sql<
      Array<NodeFull & { author_username: string; tags: string[] }>
    >`
      SELECT n.id, n.author_id, n.hierarchy_node_id, n.title, n.summary, n.cover_image,
             n.hierarchy_path, n.vote_count, n.bookmark_count, n.relation_count,
             n.x, n.y, n.created_at, n.updated_at, n.body,
             u.username AS author_username,
             coalesce(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
      FROM nodes n
      JOIN users u ON u.id = n.author_id
      LEFT JOIN node_tags nt ON nt.node_id = n.id
      LEFT JOIN tags t ON t.id = nt.tag_id
      WHERE n.id = ${id} AND n.deleted_at IS NULL
      GROUP BY n.id, u.username
    `;
    if (!row) throw notFound('Node');
    return row;
  }

  async update(userId: string, role: string, id: string, input: UpdateNodeInput): Promise<NodeFull> {
    const [existing] = await this.sql<
      Array<{ author_id: string; hierarchy_node_id: string }>
    >`SELECT author_id, hierarchy_node_id FROM nodes WHERE id = ${id} AND deleted_at IS NULL`;
    if (!existing) throw notFound('Node');
    if (existing.author_id !== userId && role !== 'moderator' && role !== 'admin') {
      throw forbidden('Only the author can edit this node');
    }

    let hierarchyPath: string[] | undefined;
    if (input.hierarchy_node_id && input.hierarchy_node_id !== existing.hierarchy_node_id) {
      const [h] = await this.sql<Array<{ status: string }>>`
        SELECT status FROM hierarchy_nodes WHERE id = ${input.hierarchy_node_id}
      `;
      if (!h) throw notFound('Hierarchy node');
      if (h.status !== 'approved') throw badRequest('Cannot move node to an unapproved branch');
      const chain = await this.sql<Array<{ name: string }>>`
        WITH RECURSIVE up AS (
          SELECT id, parent_id, name, depth FROM hierarchy_nodes WHERE id = ${input.hierarchy_node_id}
          UNION ALL
          SELECT h2.id, h2.parent_id, h2.name, h2.depth FROM hierarchy_nodes h2 JOIN up ON h2.id = up.parent_id
        )
        SELECT name FROM up ORDER BY depth
      `;
      hierarchyPath = chain.map((c) => c.name);
    }

    const parsedBody = input.body ? extractInlineLinks(input.body) : null;

    const node = await this.sql.begin(async (tx) => {
      const [row] = await tx<NodeFull[]>`
        UPDATE nodes SET
          title             = coalesce(${input.title ?? null}, title),
          summary           = CASE WHEN ${input.summary !== undefined} THEN ${input.summary ?? null} ELSE summary END,
          cover_image       = CASE WHEN ${input.cover_image !== undefined} THEN ${input.cover_image ?? null} ELSE cover_image END,
          hierarchy_node_id = coalesce(${input.hierarchy_node_id ?? null}::uuid, hierarchy_node_id),
          hierarchy_path    = coalesce(${hierarchyPath ?? null}, hierarchy_path),
          body              = coalesce(${parsedBody ? tx.json(parsedBody.body as never) : null}, body)
        WHERE id = ${id}
        RETURNING ${tx.unsafe(CARD_COLUMNS)}, body
      `;
      if (!row) throw notFound('Node');
      if (parsedBody) await this.syncInlineLinks(tx as unknown as Sql, id, parsedBody.linkedIds);
      if (input.tags) await this.syncTags(tx as unknown as Sql, id, input.tags);
      return row;
    });

    // Content changed -> re-embed; caches stale.
    if (input.title || input.summary !== undefined || input.body) {
      await this.queue.enqueueEmbedding(id);
    }
    await this.cache.del(cacheKeys.node(id), cacheKeys.trendingNodes);

    return node;
  }

  async softDelete(userId: string, role: string, id: string): Promise<void> {
    const [existing] = await this.sql<
      Array<{ author_id: string }>
    >`SELECT author_id FROM nodes WHERE id = ${id} AND deleted_at IS NULL`;
    if (!existing) throw notFound('Node');
    if (existing.author_id !== userId && role !== 'moderator' && role !== 'admin') {
      throw forbidden('Only the author can delete this node');
    }
    await this.sql`UPDATE nodes SET deleted_at = now() WHERE id = ${id}`;
    await this.cache.del(cacheKeys.node(id), cacheKeys.trendingNodes);
  }

  /** Feed listing with hierarchy / author / sort filters. */
  async list(q: ListNodesQuery): Promise<{ items: NodeCard[]; total: number }> {
    // Resolve hierarchy filter to a path prefix (subtree semantics).
    let pathPrefix: string | null = null;
    if (q.hierarchy_id) {
      const [h] = await this.sql<Array<{ path: string }>>`
        SELECT path FROM hierarchy_nodes WHERE id = ${q.hierarchy_id}
      `;
      if (!h) throw notFound('Hierarchy node');
      pathPrefix = h.path;
    } else if (q.hierarchy_path) {
      pathPrefix = q.hierarchy_path.toLowerCase();
    }

    const offset = (q.page - 1) * q.limit;
    const trendingSince = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const filters = this.sql`
      n.deleted_at IS NULL
      AND (${q.author_id ?? null}::uuid IS NULL OR n.author_id = ${q.author_id ?? null}::uuid)
      AND (${pathPrefix}::text IS NULL OR EXISTS (
        SELECT 1 FROM hierarchy_nodes h
        WHERE h.id = n.hierarchy_node_id
          AND (h.path = ${pathPrefix} OR h.path LIKE ${(pathPrefix ?? '') + '/%'})
      ))
      AND (${q.sort !== 'trending'} OR n.created_at >= ${trendingSince})
    `;

    const orderBy =
      q.sort === 'new'
        ? this.sql`n.created_at DESC`
        : this.sql`n.vote_count DESC, n.created_at DESC`;

    const items = await this.sql<NodeCard[]>`
      SELECT n.id, n.author_id, n.hierarchy_node_id, n.title, n.summary, n.cover_image,
             n.hierarchy_path, n.vote_count, n.bookmark_count, n.relation_count,
             n.x, n.y, n.created_at, n.updated_at
      FROM nodes n
      WHERE ${filters}
      ORDER BY ${orderBy}
      LIMIT ${q.limit} OFFSET ${offset}
    `;

    const [{ total }] = await this.sql<[{ total: number }]>`
      SELECT count(*)::int AS total FROM nodes n WHERE ${filters}
    `;

    return { items: [...items], total };
  }
}
