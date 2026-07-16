// src/services/graph.ts
// Graph traversal over node_relations (typed edges) + node_inline_links (soft edges).
// All traversal happens in PostgreSQL via recursive CTEs — no multi-round-trip BFS.
import type { Sql } from 'postgres';
import type {
  GraphEdge,
  GraphPayload,
  GraphVertex,
  HierarchyCluster,
  NodeRelationType,
} from '../types/index.js';
import type { ViewportQuery } from '../schemas/graph.js';
import { notFound } from '../utils/envelope.js';

interface EdgeRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  relation_type: NodeRelationType;
}

const VERTEX_COLUMNS = `
  id, title, summary, cover_image, hierarchy_path,
  vote_count, relation_count, x, y
`;

export class GraphService {
  constructor(private readonly sql: Sql) {}

  private async fetchVertices(ids: string[]): Promise<GraphVertex[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql<GraphVertex[]>`
      SELECT id, title, summary, cover_image, hierarchy_path,
             vote_count, relation_count, x, y
      FROM nodes
      WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
    `;
    return rows;
  }

  private async fetchInlineEdges(ids: string[]): Promise<GraphEdge[]> {
    if (ids.length === 0) return [];
    const rows = await this.sql<
      Array<{ from_node_id: string; to_node_id: string }>
    >`
      SELECT from_node_id, to_node_id
      FROM node_inline_links
      WHERE from_node_id = ANY(${ids}::uuid[]) AND to_node_id = ANY(${ids}::uuid[])
    `;
    return rows.map((r) => ({
      id: `inline:${r.from_node_id}:${r.to_node_id}`,
      from: r.from_node_id,
      to: r.to_node_id,
      type: 'inline' as const,
      inline: true,
    }));
  }

  private static typedEdge(r: EdgeRow): GraphEdge {
    return { id: r.id, from: r.from_node_id, to: r.to_node_id, type: r.relation_type, inline: false };
  }

  /** Ego graph: the node + everything within `depth` hops (edges walked in both directions). */
  async getEgoGraph(nodeId: string, depth: number): Promise<GraphPayload & { root: GraphVertex }> {
    const [root] = await this.fetchVertices([nodeId]);
    if (!root) throw notFound('Node');

    const edges = await this.sql<EdgeRow[]>`
      WITH RECURSIVE frontier(node_id, depth) AS (
        SELECT ${nodeId}::uuid, 0
        UNION
        SELECT CASE WHEN nr.from_node_id = f.node_id THEN nr.to_node_id ELSE nr.from_node_id END,
               f.depth + 1
        FROM node_relations nr
        JOIN frontier f ON f.node_id IN (nr.from_node_id, nr.to_node_id)
        WHERE f.depth < ${depth}
      )
      SELECT DISTINCT nr.id, nr.from_node_id, nr.to_node_id, nr.relation_type
      FROM node_relations nr
      WHERE nr.from_node_id IN (SELECT node_id FROM frontier)
        AND nr.to_node_id   IN (SELECT node_id FROM frontier)
    `;

    const vertexIds = new Set<string>([nodeId]);
    for (const e of edges) {
      vertexIds.add(e.from_node_id);
      vertexIds.add(e.to_node_id);
    }
    const ids = [...vertexIds];

    const [vertices, inlineEdges] = await Promise.all([
      this.fetchVertices(ids),
      this.fetchInlineEdges(ids),
    ]);

    return {
      root,
      vertices,
      edges: [...edges.map(GraphService.typedEdge), ...inlineEdges],
    };
  }

  /** Full graph of all nodes under a hierarchy subtree (path-prefix match). */
  async getHierarchyGraph(hierarchyId: string): Promise<GraphPayload> {
    const [h] = await this.sql<Array<{ path: string }>>`
      SELECT path FROM hierarchy_nodes WHERE id = ${hierarchyId} AND status = 'approved'
    `;
    if (!h) throw notFound('Hierarchy node');

    const vertices = await this.sql<GraphVertex[]>`
      SELECT n.id, n.title, n.summary, n.cover_image, n.hierarchy_path,
             n.vote_count, n.relation_count, n.x, n.y
      FROM nodes n
      JOIN hierarchy_nodes h ON h.id = n.hierarchy_node_id
      WHERE n.deleted_at IS NULL
        AND (h.path = ${h.path} OR h.path LIKE ${h.path + '/%'})
      LIMIT 2000
    `;

    const ids = vertices.map((v) => v.id);
    if (ids.length === 0) return { vertices: [], edges: [] };

    const [typed, inline] = await Promise.all([
      this.sql<EdgeRow[]>`
        SELECT id, from_node_id, to_node_id, relation_type
        FROM node_relations
        WHERE from_node_id = ANY(${ids}::uuid[]) AND to_node_id = ANY(${ids}::uuid[])
      `,
      this.fetchInlineEdges(ids),
    ]);

    return { vertices, edges: [...typed.map(GraphService.typedEdge), ...inline] };
  }

  /**
   * Learning path: walk `prerequisite` edges upstream from the target node,
   * topologically sorted (furthest prerequisite first, target last).
   * Edge semantics: (from) -[prerequisite]-> (to) means "read `to` before `from`".
   */
  async getLearningPath(nodeId: string): Promise<GraphVertex[]> {
    const [target] = await this.fetchVertices([nodeId]);
    if (!target) throw notFound('Node');

    const rows = await this.sql<Array<{ node_id: string; depth: number }>>`
      WITH RECURSIVE prereqs(node_id, depth) AS (
        SELECT nr.to_node_id, 1
        FROM node_relations nr
        WHERE nr.from_node_id = ${nodeId} AND nr.relation_type = 'prerequisite'
        UNION ALL
        SELECT nr.to_node_id, p.depth + 1
        FROM node_relations nr
        JOIN prereqs p ON nr.from_node_id = p.node_id
        WHERE nr.relation_type = 'prerequisite' AND p.depth < 25
      )
      SELECT node_id, max(depth)::int AS depth
      FROM prereqs
      GROUP BY node_id
      ORDER BY depth DESC
    `;

    const ordered = rows.map((r) => r.node_id).filter((id) => id !== nodeId);
    const vertices = await this.fetchVertices(ordered);
    const byId = new Map(vertices.map((v) => [v.id, v]));
    const path = ordered.map((id) => byId.get(id)).filter((v): v is GraphVertex => Boolean(v));
    path.push(target);
    return path;
  }

  /** Direct neighbors, optionally filtered by relation type. */
  async getRelatedNodes(
    nodeId: string,
    type?: NodeRelationType,
  ): Promise<Array<{ node: GraphVertex; relation: GraphEdge; direction: 'out' | 'in' }>> {
    const edges = await this.sql<EdgeRow[]>`
      SELECT id, from_node_id, to_node_id, relation_type
      FROM node_relations
      WHERE (from_node_id = ${nodeId} OR to_node_id = ${nodeId})
        AND (${type ?? null}::node_relation_type IS NULL OR relation_type = ${type ?? null}::node_relation_type)
    `;

    const neighborIds = edges.map((e) =>
      e.from_node_id === nodeId ? e.to_node_id : e.from_node_id,
    );
    const vertices = await this.fetchVertices(neighborIds);
    const byId = new Map(vertices.map((v) => [v.id, v]));

    const out: Array<{ node: GraphVertex; relation: GraphEdge; direction: 'out' | 'in' }> = [];
    for (const e of edges) {
      const direction = e.from_node_id === nodeId ? 'out' : 'in';
      const neighbor = byId.get(direction === 'out' ? e.to_node_id : e.from_node_id);
      if (neighbor) out.push({ node: neighbor, relation: GraphService.typedEdge(e), direction });
    }
    return out;
  }

  /**
   * Map viewport: Google-Maps-style tiled loading. What comes back depends on zoom:
   *   zoom < 0.3   -> continents/countries (hierarchy depth <= 1)
   *   0.3 - 1.0    -> all hierarchy clusters as blobs with node-count badges
   *   zoom > 1.0   -> clusters + individual node cards + edges among visible nodes
   */
  async getViewport(q: ViewportQuery): Promise<{
    viewport: ViewportQuery;
    hierarchy_clusters: HierarchyCluster[];
    vertices: GraphVertex[];
    edges: GraphEdge[];
  }> {
    const minX = q.x - q.width / 2;
    const maxX = q.x + q.width / 2;
    const minY = q.y - q.height / 2;
    const maxY = q.y + q.height / 2;

    const maxDepth = q.zoom < 0.3 ? 1 : 10;

    const clusters = await this.sql<HierarchyCluster[]>`
      SELECT id, name AS label, path, x, y, radius, node_count, depth
      FROM hierarchy_nodes
      WHERE status = 'approved'
        AND depth <= ${maxDepth}
        AND x BETWEEN ${minX} AND ${maxX}
        AND y BETWEEN ${minY} AND ${maxY}
      ORDER BY depth, node_count DESC
      LIMIT 500
    `;

    if (q.zoom <= 1.0) {
      return { viewport: q, hierarchy_clusters: clusters, vertices: [], edges: [] };
    }

    const vertices = await this.sql<GraphVertex[]>`
      SELECT id, title, summary, cover_image, hierarchy_path,
             vote_count, relation_count, x, y
      FROM nodes
      WHERE deleted_at IS NULL
        AND x BETWEEN ${minX} AND ${maxX}
        AND y BETWEEN ${minY} AND ${maxY}
      ORDER BY vote_count DESC
      LIMIT 500
    `;

    const ids = vertices.map((v) => v.id);
    let edges: GraphEdge[] = [];
    if (ids.length > 0) {
      const [typed, inline] = await Promise.all([
        this.sql<EdgeRow[]>`
          SELECT id, from_node_id, to_node_id, relation_type
          FROM node_relations
          WHERE from_node_id = ANY(${ids}::uuid[]) AND to_node_id = ANY(${ids}::uuid[])
        `,
        this.fetchInlineEdges(ids),
      ]);
      edges = [...typed.map(GraphService.typedEdge), ...inline];
    }

    return { viewport: q, hierarchy_clusters: clusters, vertices, edges };
  }
}

// Keep referenced constant alive for consumers building custom vertex queries.
export { VERTEX_COLUMNS };
