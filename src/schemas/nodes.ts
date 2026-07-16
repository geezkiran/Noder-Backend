// src/schemas/nodes.ts
// Strict block-schema validation on ingest, per spec.
import { z } from 'zod';
import { paginationSchema, uuidSchema } from './common.js';

// ---------- body blocks ----------

const textBlockSchema = z
  .object({
    type: z.literal('text'),
    content: z.string().min(1).max(20_000),
    // inline_links is derived server-side from [[node:uuid]] syntax; clients may send it, we recompute.
    inline_links: z
      .array(z.object({ node_id: uuidSchema, display_text: z.string() }))
      .optional(),
  })
  .strict();

const imageBlockSchema = z
  .object({
    type: z.literal('image'),
    url: z.string().url(),
    caption: z.string().max(500).optional(),
  })
  .strict();

const videoBlockSchema = z
  .object({
    type: z.literal('video'),
    url: z.string().url(),
    provider: z.enum(['youtube', 'vimeo', 'direct']),
  })
  .strict();

const linkBlockSchema = z
  .object({
    type: z.literal('link'),
    url: z.string().url(),
    preview: z
      .object({
        title: z.string().max(300).optional(),
        description: z.string().max(1000).optional(),
        image: z.string().url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const codeBlockSchema = z
  .object({
    type: z.literal('code'),
    language: z.string().min(1).max(40),
    content: z.string().min(1).max(50_000),
  })
  .strict();

const calloutBlockSchema = z
  .object({
    type: z.literal('callout'),
    variant: z.enum(['info', 'warning', 'tip']),
    content: z.string().min(1).max(5_000),
  })
  .strict();

const dividerBlockSchema = z.object({ type: z.literal('divider') }).strict();

const embedBlockSchema = z
  .object({
    type: z.literal('embed'),
    url: z.string().url(),
    provider: z.string().min(1).max(40),
  })
  .strict();

export const blockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  imageBlockSchema,
  videoBlockSchema,
  linkBlockSchema,
  codeBlockSchema,
  calloutBlockSchema,
  dividerBlockSchema,
  embedBlockSchema,
]);

export const bodySchema = z.array(blockSchema).max(200);

// ---------- node CRUD ----------

export const createNodeSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().max(280).optional(),
  cover_image: z.string().url().optional(),
  hierarchy_node_id: uuidSchema,
  body: bodySchema.default([]),
  tags: z.array(z.string().min(1).max(40)).max(10).default([]),
});

export const updateNodeSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    summary: z.string().max(280).nullable().optional(),
    cover_image: z.string().url().nullable().optional(),
    hierarchy_node_id: uuidSchema.optional(),
    body: bodySchema.optional(),
    tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const listNodesSchema = paginationSchema.extend({
  hierarchy_id: uuidSchema.optional(),
  hierarchy_path: z.string().max(500).optional(), // e.g. programming/python
  author_id: uuidSchema.optional(),
  sort: z.enum(['new', 'top', 'trending']).default('new'),
});

export const voteSchema = z.object({
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]), // 0 clears the vote
});

export type CreateNodeInput = z.infer<typeof createNodeSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>;
export type ListNodesQuery = z.infer<typeof listNodesSchema>;
