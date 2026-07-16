// src/services/ai.ts
// The AI layer: retrieve top-k relevant Nodes (pgvector cosine similarity, with a
// full-text fallback when embeddings are unavailable), compose an answer with Claude,
// and log everything to ai_query_log for the feedback loop.
import type { Sql } from 'postgres';
import type Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import type { NodeBlock } from '../types/index.js';
import { EmbeddingService } from './embeddings.js';
import { ApiError, notFound } from '../utils/envelope.js';

interface RetrievedNode {
  id: string;
  title: string;
  summary: string | null;
  body: NodeBlock[];
  hierarchy_path: string[];
  similarity: number;
}

export interface AiQueryResult {
  query_id: string;
  answer: string;
  model: string;
  sources: Array<{
    id: string;
    title: string;
    summary: string | null;
    hierarchy_path: string[];
    similarity: number;
  }>;
}

/** Only text and code block contents enter the context window; images/embeds are skipped. */
function nodeToContext(node: RetrievedNode, index: number): string {
  const parts: string[] = [];
  for (const block of node.body) {
    if (block.type === 'text') parts.push(block.content);
    else if (block.type === 'code') parts.push('```' + block.language + '\n' + block.content + '\n```');
  }
  const bodyText = parts.join('\n\n').slice(0, 6000);
  return [
    `<node index="${index + 1}" id="${node.id}">`,
    `Topic: ${node.hierarchy_path.join(' > ')}`,
    `Title: ${node.title}`,
    node.summary ? `Summary: ${node.summary}` : '',
    bodyText ? `Content:\n${bodyText}` : '',
    `</node>`,
  ]
    .filter(Boolean)
    .join('\n');
}

const SYSTEM_PROMPT = `You are Noder's knowledge assistant. Noder is a knowledge network of small,
atomic "Nodes" written by experts and organized in a topic hierarchy.

Answer the user's question using ONLY the provided nodes. Rules:
- Cite nodes inline as [1], [2], ... matching the node index attribute.
- If the nodes do not contain enough information, say so plainly and answer only what they support.
- Be concise and factual. Prefer the wording and definitions used in the nodes.
- Never invent node content or citations.`;

export class AiService {
  private readonly embeddings = new EmbeddingService();

  constructor(
    private readonly sql: Sql,
    private readonly anthropic: Anthropic | null,
  ) {}

  private async resolvePathPrefix(hierarchyNodeId?: string): Promise<string | null> {
    if (!hierarchyNodeId) return null;
    const [h] = await this.sql<Array<{ path: string }>>`
      SELECT path FROM hierarchy_nodes WHERE id = ${hierarchyNodeId}
    `;
    if (!h) throw notFound('Hierarchy node');
    return h.path;
  }

  /** pgvector cosine retrieval, constrained to a hierarchy subtree when given. */
  private async retrieveByVector(
    vector: number[],
    pathPrefix: string | null,
    topK: number,
  ): Promise<RetrievedNode[]> {
    const literal = this.embeddings.toSqlLiteral(vector);
    const rows = await this.sql<RetrievedNode[]>`
      SELECT n.id, n.title, n.summary, n.body, n.hierarchy_path,
             (1 - (n.embedding <=> ${literal}::vector))::float AS similarity
      FROM nodes n
      WHERE n.deleted_at IS NULL AND n.embedding IS NOT NULL
        AND (${pathPrefix}::text IS NULL OR EXISTS (
          SELECT 1 FROM hierarchy_nodes h
          WHERE h.id = n.hierarchy_node_id
            AND (h.path = ${pathPrefix} OR h.path LIKE ${(pathPrefix ?? '') + '/%'})
        ))
      ORDER BY n.embedding <=> ${literal}::vector
      LIMIT ${topK}
    `;
    return [...rows];
  }

  /** Full-text fallback so /ai/query still works before embeddings are configured. */
  private async retrieveByText(
    query: string,
    pathPrefix: string | null,
    topK: number,
  ): Promise<RetrievedNode[]> {
    const rows = await this.sql<RetrievedNode[]>`
      SELECT n.id, n.title, n.summary, n.body, n.hierarchy_path,
             ts_rank(n.tsv, websearch_to_tsquery('english', ${query}))::float AS similarity
      FROM nodes n
      WHERE n.deleted_at IS NULL
        AND n.tsv @@ websearch_to_tsquery('english', ${query})
        AND (${pathPrefix}::text IS NULL OR EXISTS (
          SELECT 1 FROM hierarchy_nodes h
          WHERE h.id = n.hierarchy_node_id
            AND (h.path = ${pathPrefix} OR h.path LIKE ${(pathPrefix ?? '') + '/%'})
        ))
      ORDER BY similarity DESC
      LIMIT ${topK}
    `;
    return [...rows];
  }

  async query(
    userId: string | null,
    query: string,
    hierarchyNodeId: string | undefined,
    topK: number,
  ): Promise<AiQueryResult> {
    if (!this.anthropic) {
      throw new ApiError(503, 'ai_unavailable', 'AI querying is not configured on this server');
    }

    const started = Date.now();
    const pathPrefix = await this.resolvePathPrefix(hierarchyNodeId);

    // 1. Retrieve
    let retrieved: RetrievedNode[];
    if (this.embeddings.isConfigured()) {
      const queryVector = await this.embeddings.embed(query, 'query');
      retrieved = queryVector
        ? await this.retrieveByVector(queryVector, pathPrefix, topK)
        : await this.retrieveByText(query, pathPrefix, topK);
    } else {
      retrieved = await this.retrieveByText(query, pathPrefix, topK);
    }

    // 2. Compose answer with Claude
    let answer: string;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;

    if (retrieved.length === 0) {
      answer =
        'No relevant nodes were found for this query' +
        (pathPrefix ? ` under the selected topic (${pathPrefix}).` : '.') +
        ' Try broadening the topic filter or rephrasing the question.';
    } else {
      const context = retrieved.map(nodeToContext).join('\n\n');
      const response = await this.anthropic.messages.create({
        model: config.ai.model,
        max_tokens: config.ai.maxTokens,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Here are the knowledge nodes:\n\n${context}\n\nQuestion: ${query}`,
          },
        ],
      });

      answer = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      inputTokens = response.usage.input_tokens;
      outputTokens = response.usage.output_tokens;
    }

    // 3. Log for the feedback loop / dataset improvement
    const retrievedIds = retrieved.map((r) => r.id);
    const [log] = await this.sql<Array<{ id: string }>>`
      INSERT INTO ai_query_log
        (user_id, query, hierarchy_node_id, retrieved_node_ids, answer, model,
         input_tokens, output_tokens, latency_ms)
      VALUES
        (${userId}, ${query}, ${hierarchyNodeId ?? null}, ${retrievedIds}::uuid[],
         ${answer}, ${config.ai.model}, ${inputTokens}, ${outputTokens},
         ${Date.now() - started})
      RETURNING id
    `;

    return {
      query_id: log?.id ?? '',
      answer,
      model: config.ai.model,
      sources: retrieved.map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        hierarchy_path: r.hierarchy_path,
        similarity: Number(r.similarity.toFixed(4)),
      })),
    };
  }

  /** Thumbs up/down on a previous answer. */
  async feedback(userId: string, queryId: string, feedback: 1 | -1): Promise<void> {
    const result = await this.sql`
      UPDATE ai_query_log SET feedback = ${feedback}
      WHERE id = ${queryId} AND (user_id = ${userId} OR user_id IS NULL)
    `;
    if (result.count === 0) throw notFound('AI query');
  }
}
