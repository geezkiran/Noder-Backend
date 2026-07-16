// src/workers/embedding.worker.ts
// Generates the pgvector embedding for a node: title + summary + text/code blocks.
import type { Sql } from 'postgres';
import { EmbeddingService } from '../services/embeddings.js';
import type { EmbeddingJob, NodeBlock } from '../types/index.js';

const embeddings = new EmbeddingService();

export async function processEmbeddingJob(sql: Sql, job: EmbeddingJob): Promise<void> {
  if (!embeddings.isConfigured()) {
    // No embedding provider configured — skip quietly; /ai/query falls back to full-text.
    return;
  }

  const [node] = await sql<
    Array<{ id: string; title: string; summary: string | null; body: NodeBlock[] }>
  >`
    SELECT id, title, summary, body FROM nodes
    WHERE id = ${job.nodeId} AND deleted_at IS NULL
  `;
  if (!node) return; // deleted before the job ran

  const text = embeddings.buildNodeText(node.title, node.summary, node.body);
  const vector = await embeddings.embed(text, 'document');
  if (!vector) return;

  await sql`
    UPDATE nodes SET embedding = ${embeddings.toSqlLiteral(vector)}::vector
    WHERE id = ${job.nodeId}
  `;
}
