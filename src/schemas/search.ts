// src/schemas/search.ts
import { z } from 'zod';
import { paginationSchema, uuidSchema } from './common.js';

export const searchQuerySchema = paginationSchema.extend({
  q: z.string().min(1).max(500),
  hierarchy_id: uuidSchema.optional(),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
