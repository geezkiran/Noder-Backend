// src/types/index.ts
// Shared TypeScript types used across services, routes, and workers.

// ---------- API envelope ----------

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  cursor?: string | null;
}

export interface ApiEnvelope<T> {
  success: boolean;
  data: T | null;
  error: { code: string; message: string } | null;
  meta?: ApiMeta;
}

// ---------- Auth ----------

export type UserRole = 'user' | 'moderator' | 'admin';

export interface JwtPayload {
  sub: string; // user id
  role: UserRole;
  username: string;
}

// ---------- Node body blocks ----------

export type BlockType =
  | 'text'
  | 'image'
  | 'video'
  | 'link'
  | 'code'
  | 'callout'
  | 'divider'
  | 'embed';

export interface InlineLink {
  node_id: string;
  display_text: string;
}

export interface TextBlock {
  type: 'text';
  content: string;
  inline_links?: InlineLink[];
}

export interface ImageBlock {
  type: 'image';
  url: string;
  caption?: string;
}

export interface VideoBlock {
  type: 'video';
  url: string;
  provider: 'youtube' | 'vimeo' | 'direct';
}

export interface LinkBlock {
  type: 'link';
  url: string;
  preview?: { title?: string; description?: string; image?: string };
}

export interface CodeBlock {
  type: 'code';
  language: string;
  content: string;
}

export interface CalloutBlock {
  type: 'callout';
  variant: 'info' | 'warning' | 'tip';
  content: string;
}

export interface DividerBlock {
  type: 'divider';
}

export interface EmbedBlock {
  type: 'embed';
  url: string;
  provider: string;
}

export type NodeBlock =
  | TextBlock
  | ImageBlock
  | VideoBlock
  | LinkBlock
  | CodeBlock
  | CalloutBlock
  | DividerBlock
  | EmbedBlock;

// ---------- Domain rows ----------

export type NodeRelationType =
  | 'extends'
  | 'contradicts'
  | 'references'
  | 'is_part_of'
  | 'prerequisite'
  | 'see_also';

export interface HierarchyNodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  slug: string;
  path: string;
  depth: number;
  status: 'pending' | 'approved' | 'rejected';
  x: number;
  y: number;
  radius: number;
  node_count: number;
  created_at: string;
  updated_at: string;
}

export interface NodeCard {
  id: string;
  author_id: string;
  hierarchy_node_id: string;
  title: string;
  summary: string | null;
  cover_image: string | null;
  hierarchy_path: string[];
  vote_count: number;
  bookmark_count: number;
  relation_count: number;
  x: number;
  y: number;
  created_at: string;
  updated_at: string;
}

export interface NodeFull extends NodeCard {
  body: NodeBlock[];
}

// ---------- Graph view data contract (flat vertices + flat edges) ----------

export interface GraphVertex {
  id: string;
  title: string;
  summary: string | null;
  cover_image: string | null;
  hierarchy_path: string[];
  vote_count: number;
  relation_count: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: NodeRelationType | 'inline';
  inline: boolean;
}

export interface GraphPayload {
  vertices: GraphVertex[];
  edges: GraphEdge[];
}

export interface HierarchyCluster {
  id: string;
  label: string;
  path: string;
  x: number;
  y: number;
  radius: number;
  node_count: number;
  depth: number;
}

// ---------- Queue job payloads ----------

export interface EmbeddingJob {
  nodeId: string;
}

export interface RebalanceJob {
  hierarchyNodeId: string;
}

export interface NotificationJob {
  type: 'hierarchy_approved' | 'hierarchy_rejected' | 'node_relation_created';
  recipientId: string;
  payload: Record<string, unknown>;
}
