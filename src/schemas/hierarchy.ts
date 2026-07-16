// src/schemas/hierarchy.ts
import { z } from 'zod';
import { uuidSchema } from './common.js';

export const proposeBranchSchema = z.object({
  parent_id: uuidSchema,
  name: z.string().min(2).max(80),
  reason: z.string().max(1000).optional(),
});

export const approveBranchSchema = z.object({
  decision: z.enum(['approved', 'rejected']).default('approved'),
});

export type ProposeBranchInput = z.infer<typeof proposeBranchSchema>;
