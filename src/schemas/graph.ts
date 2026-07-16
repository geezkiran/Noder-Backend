// src/schemas/graph.ts
import { z } from 'zod';

export const egoGraphQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(4).default(1),
});

export const viewportQuerySchema = z.object({
  x: z.coerce.number(),
  y: z.coerce.number(),
  width: z.coerce.number().positive().max(200_000),
  height: z.coerce.number().positive().max(200_000),
  zoom: z.coerce.number().min(0.05).max(10).default(1),
});

export type ViewportQuery = z.infer<typeof viewportQuerySchema>;
