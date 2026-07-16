// src/services/embeddings.ts
// Vendor-abstracted embeddings layer (Voyage AI free tier by default).
// Embeds title + summary + text/code block contents only — never the full body JSON.
import { config } from '../config.js';
import type { NodeBlock } from '../types/index.js';

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';

export class EmbeddingService {
  isConfigured(): boolean {
    return Boolean(config.embeddings.apiKey);
  }

  /** Build the canonical embedding text for a node, per spec. */
  buildNodeText(title: string, summary: string | null, body: NodeBlock[]): string {
    const parts: string[] = [title];
    if (summary) parts.push(summary);
    for (const block of body) {
      if (block.type === 'text') parts.push(block.content);
      else if (block.type === 'code') parts.push(block.content);
      // images, embeds, videos, links, callouts, dividers are skipped
    }
    return parts.join('\n\n').slice(0, 32_000);
  }

  async embed(text: string, inputType: 'document' | 'query'): Promise<number[] | null> {
    if (!this.isConfigured()) return null;

    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.embeddings.apiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddings.model,
        input: [text],
        input_type: inputType,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Embedding API error ${res.status}: ${detail.slice(0, 300)}`);
    }

    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const vector = json.data[0]?.embedding;
    if (!vector || vector.length !== config.embeddings.dim) {
      throw new Error(
        `Embedding dimension mismatch: expected ${config.embeddings.dim}, got ${vector?.length ?? 0}`,
      );
    }
    return vector;
  }

  /** pgvector literal: '[0.1,0.2,...]' — pass as a string param cast with ::vector. */
  toSqlLiteral(vector: number[]): string {
    return `[${vector.join(',')}]`;
  }
}
