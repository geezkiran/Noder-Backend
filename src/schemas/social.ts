// src/schemas/social.ts
import { z } from 'zod';
import { uuidSchema } from './common.js';

export const followSchema = z
  .object({
    target_type: z.enum(['user', 'hierarchy']),
    target_id: uuidSchema,
  })
  .strict();

export type FollowInput = z.infer<typeof followSchema>;
