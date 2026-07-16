// src/schemas/ai.ts
import { z } from 'zod';
import { uuidSchema } from './common.js';

export const aiQuerySchema = z.object({
  query: z.string().min(3).max(2000),
  hierarchy_node_id: uuidSchema.optional(), // constrain retrieval to a subtree
  top_k: z.coerce.number().int().min(1).max(20).default(8),
});

export const aiFeedbackSchema = z.object({
  feedback: z.union([z.literal(1), z.literal(-1)]),
});

export type AiQueryInput = z.infer<typeof aiQuerySchema>;
