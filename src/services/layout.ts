// src/services/layout.ts
// Deterministic map layout. Positions are computed once at creation and stored;
// they never drift. Only layout:rebalance (dense clusters) redistributes positions,
// and only inside the cluster boundary.
import type { Sql } from 'postgres';

export interface Point {
  x: number;
  y: number;
}

export const CANVAS_SIZE = 100_000;
export const ROOT_RADIUS = 8_000;
export const CHILD_RADIUS_FACTOR = 0.4; // each level shrinks 60%
export const NODE_RING_FACTOR = 0.3; // post nodes sit on a ring at 30% of leaf radius
export const REBALANCE_THRESHOLD = 50;

/** Radial placement of the i-th of `total` children around a parent. */
export function childPosition(
  parent: { x: number; y: number; radius: number },
  index: number,
  total: number,
): Point {
  const angle = (2 * Math.PI * index) / Math.max(total, 1);
  return {
    x: parent.x + parent.radius * Math.cos(angle),
    y: parent.y + parent.radius * Math.sin(angle),
  };
}

export function childRadius(parentRadius: number): number {
  return parentRadius * CHILD_RADIUS_FACTOR;
}

/** Radial placement of the i-th of `total` post nodes inside a hierarchy leaf cluster. */
export function nodePosition(
  leaf: { x: number; y: number; radius: number },
  index: number,
  total: number,
): Point {
  const angle = (2 * Math.PI * index) / Math.max(total, 1);
  const r = leaf.radius * NODE_RING_FACTOR;
  return {
    x: leaf.x + r * Math.cos(angle),
    y: leaf.y + r * Math.sin(angle),
  };
}

export class LayoutService {
  constructor(private readonly sql: Sql) {}

  /** Position for a newly approved hierarchy child, based on sibling count. */
  async placeHierarchyChild(parentId: string): Promise<{ x: number; y: number; radius: number }> {
    const [parent] = await this.sql<
      Array<{ x: number; y: number; radius: number }>
    >`SELECT x, y, radius FROM hierarchy_nodes WHERE id = ${parentId}`;
    if (!parent) throw new Error(`Hierarchy parent ${parentId} not found`);

    const [{ count }] = await this.sql<
      [{ count: number }]
    >`SELECT count(*)::int AS count FROM hierarchy_nodes WHERE parent_id = ${parentId}`;

    // Place as the (count)-th child of (count + 1) total; existing siblings keep
    // their stored positions — the map never moves under the user.
    const pos = childPosition(parent, count, count + 1);
    return { ...pos, radius: childRadius(parent.radius) };
  }

  /** Position for a new post node inside its hierarchy cluster. */
  async placeNode(hierarchyNodeId: string): Promise<Point> {
    const [leaf] = await this.sql<
      Array<{ x: number; y: number; radius: number; node_count: number }>
    >`SELECT x, y, radius, node_count FROM hierarchy_nodes WHERE id = ${hierarchyNodeId}`;
    if (!leaf) throw new Error(`Hierarchy node ${hierarchyNodeId} not found`);

    return nodePosition(leaf, leaf.node_count, leaf.node_count + 1);
  }

  /**
   * Redistribute all post nodes of one cluster evenly on concentric rings.
   * Touches only this cluster; other clusters' coordinates are untouched.
   * Runs in the layout:rebalance worker when node_count > REBALANCE_THRESHOLD.
   */
  async rebalanceCluster(hierarchyNodeId: string): Promise<number> {
    const [leaf] = await this.sql<
      Array<{ x: number; y: number; radius: number }>
    >`SELECT x, y, radius FROM hierarchy_nodes WHERE id = ${hierarchyNodeId}`;
    if (!leaf) return 0;

    const nodes = await this.sql<
      Array<{ id: string }>
    >`SELECT id FROM nodes WHERE hierarchy_node_id = ${hierarchyNodeId} AND deleted_at IS NULL ORDER BY created_at`;
    if (nodes.length === 0) return 0;

    const perRing = 24;
    const updates = nodes.map((node, i) => {
      const ring = Math.floor(i / perRing);
      const posInRing = i % perRing;
      const ringTotal = Math.min(nodes.length - ring * perRing, perRing);
      // rings step outward from 30% to 90% of the cluster radius
      const r = leaf.radius * Math.min(NODE_RING_FACTOR + ring * 0.15, 0.9);
      const angle = (2 * Math.PI * posInRing) / Math.max(ringTotal, 1);
      return {
        id: node.id,
        x: leaf.x + r * Math.cos(angle),
        y: leaf.y + r * Math.sin(angle),
      };
    });

    await this.sql.begin(async (tx) => {
      for (const u of updates) {
        await tx`UPDATE nodes SET x = ${u.x}, y = ${u.y} WHERE id = ${u.id}`;
      }
    });

    return updates.length;
  }
}
