// src/schemas/relations.ts
import { z } from 'zod';
import { uuidSchema } from './common.js';

export const relationTypeSchema = z.enum([
  'extends',
  'contradicts',
  'references',
  'is_part_of',
  'prerequisite',
  'see_also',
]);

export const createRelationSchema = z.object({
  to_node_id: uuidSchema,
  relation_type: relationTypeSchema,
});

export const relatedQuerySchema = z.object({
  type: relationTypeSchema.optional(),
});

export type CreateRelationInput = z.infer<typeof createRelationSchema>;
