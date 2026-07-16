// src/services/relations.ts
// Typed graph edges between nodes.
import type { Sql } from 'postgres';
import type { NodeRelationType } from '../types/index.js';
import type { QueueService } from './queue.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/envelope.js';

export interface RelationRow {
  id: string;
  from_node_id: string;
  to_node_id: string;
  relation_type: NodeRelationType;
  created_by: string;
  created_at: string;
}

export class RelationService {
  constructor(
    private readonly sql: Sql,
    private readonly queue: QueueService,
  ) {}

  async create(
    userId: string,
    fromNodeId: string,
    toNodeId: string,
    relationType: NodeRelationType,
  ): Promise<RelationRow> {
    if (fromNodeId === toNodeId) throw badRequest('A node cannot relate to itself');

    const nodes = await this.sql<Array<{ id: string; author_id: string }>>`
      SELECT id, author_id FROM nodes
      WHERE id IN (${fromNodeId}, ${toNodeId}) AND deleted_at IS NULL
    `;
    if (nodes.length !== 2) throw notFound('Node');

    const [existing] = await this.sql`
      SELECT id FROM node_relations
      WHERE from_node_id = ${fromNodeId} AND to_node_id = ${toNodeId}
        AND relation_type = ${relationType}::node_relation_type
    `;
    if (existing) throw conflict('This relation already exists');

    // Prerequisite edges must stay acyclic or learning paths break.
    if (relationType === 'prerequisite') {
      const [cycle] = await this.sql`
        WITH RECURSIVE walk(node_id, depth) AS (
          SELECT ${toNodeId}::uuid, 0
          UNION ALL
          SELECT nr.to_node_id, w.depth + 1
          FROM node_relations nr JOIN walk w ON nr.from_node_id = w.node_id
          WHERE nr.relation_type = 'prerequisite' AND w.depth < 50
        )
        SELECT 1 AS hit FROM walk WHERE node_id = ${fromNodeId} LIMIT 1
      `;
      if (cycle) throw badRequest('This prerequisite would create a cycle');
    }

    const [row] = await this.sql<RelationRow[]>`
      INSERT INTO node_relations (from_node_id, to_node_id, relation_type, created_by)
      VALUES (${fromNodeId}, ${toNodeId}, ${relationType}::node_relation_type, ${userId})
      RETURNING id, from_node_id, to_node_id, relation_type, created_by, created_at
    `;
    if (!row) throw new Error('Failed to insert relation');

    // Notify the target node's author that their node was linked.
    const target = nodes.find((n) => n.id === toNodeId);
    if (target && target.author_id !== userId) {
      await this.queue.enqueueNotification({
        type: 'node_relation_created',
        recipientId: target.author_id,
        payload: { from_node_id: fromNodeId, to_node_id: toNodeId, relation_type: relationType },
      });
    }

    return row;
  }

  async remove(userId: string, role: string, nodeId: string, relationId: string): Promise<void> {
    const [rel] = await this.sql<RelationRow[]>`
      SELECT id, from_node_id, to_node_id, relation_type, created_by, created_at
      FROM node_relations
      WHERE id = ${relationId} AND (from_node_id = ${nodeId} OR to_node_id = ${nodeId})
    `;
    if (!rel) throw notFound('Relation');
    if (rel.created_by !== userId && role !== 'moderator' && role !== 'admin') {
      throw forbidden('Only the creator of a relation can remove it');
    }
    await this.sql`DELETE FROM node_relations WHERE id = ${relationId}`;
  }
}
