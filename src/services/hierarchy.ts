// src/services/hierarchy.ts
// The living taxonomy: tree reads (Redis-cached, 1hr TTL), branch proposals,
// moderator approval. Positions are assigned at creation and finalized on approval.
import type { Sql } from 'postgres';
import type { HierarchyNodeRow } from '../types/index.js';
import type { CacheService } from './cache.js';
import { cacheKeys, cacheTtl } from './cache.js';
import { LayoutService } from './layout.js';
import type { QueueService } from './queue.js';
import { badRequest, conflict, notFound } from '../utils/envelope.js';

export interface HierarchyTreeNode extends HierarchyNodeRow {
  children: HierarchyTreeNode[];
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class HierarchyService {
  private readonly layout: LayoutService;

  constructor(
    private readonly sql: Sql,
    private readonly cache: CacheService,
    private readonly queue: QueueService,
  ) {
    this.layout = new LayoutService(sql);
  }

  /** Full approved tree, cached in Redis for 1 hour. */
  async getTree(): Promise<HierarchyTreeNode[]> {
    return this.cache.wrap(cacheKeys.hierarchyTree, cacheTtl.hierarchyTree, async () => {
      const rows = await this.sql<HierarchyNodeRow[]>`
        SELECT id, parent_id, name, slug, path, depth, status, x, y, radius, node_count,
               created_at, updated_at
        FROM hierarchy_nodes
        WHERE status = 'approved'
        ORDER BY depth, name
      `;

      const byId = new Map<string, HierarchyTreeNode>();
      const roots: HierarchyTreeNode[] = [];
      for (const row of rows) byId.set(row.id, { ...row, children: [] });
      for (const node of byId.values()) {
        const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      return roots;
    });
  }

  async getById(id: string): Promise<HierarchyNodeRow> {
    const [row] = await this.sql<HierarchyNodeRow[]>`
      SELECT id, parent_id, name, slug, path, depth, status, x, y, radius, node_count,
             created_at, updated_at
      FROM hierarchy_nodes WHERE id = ${id}
    `;
    if (!row) throw notFound('Hierarchy node');
    return row;
  }

  async getChildren(id: string): Promise<HierarchyNodeRow[]> {
    await this.getById(id); // 404 if missing
    return this.cache.wrap(cacheKeys.hierarchyChildren(id), cacheTtl.hierarchyChildren, async () => {
      const rows = await this.sql<HierarchyNodeRow[]>`
        SELECT id, parent_id, name, slug, path, depth, status, x, y, radius, node_count,
               created_at, updated_at
        FROM hierarchy_nodes
        WHERE parent_id = ${id} AND status = 'approved'
        ORDER BY name
      `;
      return [...rows];
    });
  }

  /** User proposes a new branch -> pending hierarchy node + moderation queue entry. */
  async propose(
    userId: string,
    input: { parent_id: string; name: string; reason?: string },
  ): Promise<{ hierarchy_node: HierarchyNodeRow; moderation_id: string }> {
    const parent = await this.getById(input.parent_id);
    if (parent.status !== 'approved') throw badRequest('Parent branch is not approved');
    if (parent.depth >= 6) throw badRequest('Maximum hierarchy depth reached');

    const slug = slugify(input.name);
    if (!slug) throw badRequest('Name produces an empty slug');
    const path = `${parent.path}/${slug}`;

    const [existing] = await this.sql`SELECT id FROM hierarchy_nodes WHERE path = ${path}`;
    if (existing) throw conflict(`Branch "${path}" already exists or is pending`);

    // Position is computed at proposal time so moderators can preview placement.
    const pos = await this.layout.placeHierarchyChild(parent.id);

    return this.sql.begin(async (tx) => {
      const [node] = await tx<HierarchyNodeRow[]>`
        INSERT INTO hierarchy_nodes (parent_id, name, slug, path, depth, status, created_by, x, y, radius)
        VALUES (${parent.id}, ${input.name}, ${slug}, ${path}, ${parent.depth + 1}, 'pending',
                ${userId}, ${pos.x}, ${pos.y}, ${pos.radius})
        RETURNING id, parent_id, name, slug, path, depth, status, x, y, radius, node_count,
                  created_at, updated_at
      `;
      if (!node) throw new Error('Failed to insert hierarchy node');

      const [mod] = await tx<Array<{ id: string }>>`
        INSERT INTO moderation_queue (item_type, hierarchy_node_id, payload, proposed_by)
        VALUES ('hierarchy_proposal', ${node.id},
                ${tx.json({ name: input.name, path, reason: input.reason ?? null })},
                ${userId})
        RETURNING id
      `;
      if (!mod) throw new Error('Failed to insert moderation entry');

      return { hierarchy_node: node, moderation_id: mod.id };
    });
  }

  /** Moderator approves/rejects a pending branch. */
  async review(
    moderatorId: string,
    hierarchyNodeId: string,
    decision: 'approved' | 'rejected',
  ): Promise<HierarchyNodeRow> {
    const node = await this.getById(hierarchyNodeId);
    if (node.status !== 'pending') throw conflict('Branch is not pending review');

    const [updated] = await this.sql<HierarchyNodeRow[]>`
      UPDATE hierarchy_nodes
      SET status = ${decision}
      WHERE id = ${hierarchyNodeId}
      RETURNING id, parent_id, name, slug, path, depth, status, x, y, radius, node_count,
                created_at, updated_at
    `;
    if (!updated) throw notFound('Hierarchy node');

    await this.sql`
      UPDATE moderation_queue
      SET status = ${decision}, reviewed_by = ${moderatorId}, reviewed_at = now()
      WHERE hierarchy_node_id = ${hierarchyNodeId} AND status = 'pending'
    `;

    // Invalidate cached tree + children of the parent.
    await this.cache.del(cacheKeys.hierarchyTree);
    if (updated.parent_id) await this.cache.del(cacheKeys.hierarchyChildren(updated.parent_id));

    // Notify the proposer (hierarchy approval events, per spec).
    const [mod] = await this.sql<Array<{ proposed_by: string }>>`
      SELECT proposed_by FROM moderation_queue WHERE hierarchy_node_id = ${hierarchyNodeId}
      ORDER BY created_at DESC LIMIT 1
    `;
    if (mod) {
      await this.queue.enqueueNotification({
        type: decision === 'approved' ? 'hierarchy_approved' : 'hierarchy_rejected',
        recipientId: mod.proposed_by,
        payload: { hierarchy_node_id: updated.id, path: updated.path },
      });
    }

    return updated;
  }

  async listPending(): Promise<Array<Record<string, unknown>>> {
    const rows = await this.sql`
      SELECT m.id AS moderation_id, m.payload, m.created_at, m.proposed_by,
             u.username AS proposed_by_username,
             h.id AS hierarchy_node_id, h.name, h.path, h.depth
      FROM moderation_queue m
      JOIN hierarchy_nodes h ON h.id = m.hierarchy_node_id
      JOIN users u ON u.id = m.proposed_by
      WHERE m.status = 'pending'
      ORDER BY m.created_at
    `;
    return [...rows];
  }
}
