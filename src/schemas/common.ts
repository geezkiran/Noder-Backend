// src/schemas/common.ts
import { z } from 'zod';

export const uuidSchema = z.string().uuid();

export const idParamSchema = z.object({ id: uuidSchema });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type Pagination = z.infer<typeof paginationSchema>;

export function offsetOf(p: Pagination): number {
  return (p.page - 1) * p.limit;
}
