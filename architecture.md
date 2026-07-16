You are a senior backend architect. Build the complete enterprise-grade backend 
and database architecture for **Noder** — a social network for context layers, 
and implement it fully in code.

---

## PRODUCT CONTEXT

Noder is a knowledge social network where:
- Users post **Nodes** — tiny, atomic packets of information (think: a single 
  concept, a step in a tutorial, a fact, a definition).
- Nodes are organized in a **strict content hierarchy**: every Node must be 
  tagged with its exact position in the tree (e.g., `Programming > Python > 
  Decorators > Syntax`).
- The hierarchy is a **living taxonomy** — users can propose new branches, 
  moderators approve them.
- An **AI layer** uses this structured dataset to answer user queries by 
  fetching, ranking, and composing relevant Nodes.
- Users can follow branches of the hierarchy, not just other users.
- Nodes can be linked (parent-child, related, contradicts, extends) forming 
  a **graph within the tree**.


---

## NODE (POST) CONTENT SPEC

A Node has two layers:

**Card layer** (what appears in feed — like a tweet card):
- `title` — required, short (max 120 chars), the hook. Displayed prominently on the card.
- `summary` — optional, 1-2 line preview (max 280 chars), shown below title in feed.
- `cover_image` — optional, single image shown on card thumbnail.
- `hierarchy_path` — the tag chain shown on card (e.g., `Python > Decorators > Syntax`).

**Body layer** (the full post — like a course lesson page):
A rich, block-based content document. The body is a JSON array of ordered blocks:

```json
[
  { "type": "text",     "content": "Markdown string here" },
  { "type": "image",    "url": "...", "caption": "..." },
  { "type": "video",    "url": "...", "provider": "youtube|vimeo|direct" },
  { "type": "link",     "url": "...", "preview": { "title": "...", "description": "...", "image": "..." } },
  { "type": "code",     "language": "python", "content": "..." },
  { "type": "callout",  "variant": "info|warning|tip", "content": "..." },
  { "type": "divider"  },
  { "type": "embed",    "url": "...", "provider": "codepen|codesandbox|figma|..." }
]
```

Store `body` as `JSONB` in Postgres. Validate block schema strictly with Zod on ingest.
Index `title` and `summary` in `tsvector` for full-text search.
Embed `title + summary + text blocks` concatenated for pgvector semantic search — 
not the full body JSON.

For AI querying: extract only `text` and `code` block contents when building 
the embedding or context window. Images and embeds are skipped.
---
````
## GRAPH ARCHITECTURE: NODES AS A CONNECTED KNOWLEDGE GRAPH

Every Node (post) is both a piece of content AND a vertex in a graph.
The graph is the product. The feed is just one view of it.

---

### GRAPH SCHEMA

**Vertices** = Nodes (posts)
**Edges** = typed, directional relations between Nodes

```sql
CREATE TABLE node_relations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node_id  UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_node_id    UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation_type node_relation_type NOT NULL,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (from_node_id, to_node_id, relation_type)
);

CREATE TYPE node_relation_type AS ENUM (
  'extends',        -- this Node builds on that Node
  'contradicts',    -- this Node challenges that Node
  'references',     -- this Node cites that Node
  'is_part_of',     -- this Node is a chapter/section of that Node
  'prerequisite',   -- that Node should be read before this one
  'see_also'        -- loosely related, same topic space
);
```

Also: within a Node's body blocks, inline linking is supported:
```json
{ 
  "type": "text", 
  "content": "This builds on [[node:uuid]] which covers the basics.",
  "inline_links": [
    { "node_id": "uuid", "display_text": "node:uuid" }
  ]
}
```
Parse `[[node:uuid]]` syntax on ingest, extract to `inline_links` array,
store both. Inline links are soft graph edges — they show up in the graph 
view but are not typed relations.

---

### GRAPH API ENDPOINTS
````

GET /api/v1/nodes/:id/graph

````
Returns the ego graph of a Node — the node itself + all connected nodes 
(1 hop by default, `?depth=2` for 2 hops):
```json
{
  "data": {
    "root": { ...node },
    "vertices": [ { ...node }, { ...node } ],
    "edges": [
      { 
        "from": "uuid", 
        "to": "uuid", 
        "type": "extends",
        "inline": false 
      }
    ]
  }
}
```
````

GET /api/v1/hierarchy/:id/graph

```
Returns the full graph of all Nodes under a hierarchy subtree.
Used to render the knowledge graph for an entire topic (e.g., all of "Python").
```

POST /api/v1/nodes/:id/relations

```
Create a typed relation edge between two Nodes.
Body: `{ "to_node_id": "uuid", "relation_type": "extends" }`
```

DELETE /api/v1/nodes/:id/relations/:relation_id

```
Remove an edge.
```

GET /api/v1/nodes/:id/prerequisites

````
Traverses the graph upstream via `prerequisite` edges — returns the 
ordered learning path to reach this Node. Used for "learn this topic" flow.

---

### GRAPH TRAVERSAL SERVICE

Implement `src/services/graph.ts`:
- `getEgoGraph(nodeId, depth)` — BFS from a node up to N hops
- `getHierarchyGraph(hierarchyId)` — all nodes + all edges within a subtree  
- `getLearningPath(nodeId)` — upstream prerequisite chain, topologically sorted
- `getRelatedNodes(nodeId, type?)` — filtered by relation type

Use recursive CTEs in PostgreSQL for traversal — do NOT do multi-round-trip 
BFS in application code:

```sql
WITH RECURSIVE graph AS (
  SELECT from_node_id, to_node_id, relation_type, 1 AS depth
  FROM node_relations
  WHERE from_node_id = $1

  UNION ALL

  SELECT nr.from_node_id, nr.to_node_id, nr.relation_type, g.depth + 1
  FROM node_relations nr
  JOIN graph g ON nr.from_node_id = g.to_node_id
  WHERE g.depth < $2
)
SELECT * FROM graph;
```

---

### GRAPH VIEW DATA CONTRACT

The frontend graph view (web + mobile) will use a force-directed or 
hierarchical renderer (e.g., D3, Cytoscape, or React Flow on web; 
custom Canvas on mobile).

The API must always return graph data in this shape so any renderer can 
consume it without transformation:

```json
{
  "vertices": [
    { 
      "id": "uuid",
      "title": "...",
      "summary": "...",
      "cover_image": "...",
      "hierarchy_path": ["Python", "Decorators", "Syntax"],
      "vote_count": 42,
      "relation_count": 7
    }
  ],
  "edges": [
    { "id": "uuid", "from": "uuid", "to": "uuid", "type": "extends", "inline": false }
  ]
}
```

No nesting. Flat vertices + flat edges. The client builds the graph from this.


````
## SPATIAL GRAPH: FIXED-POSITION, MAP-LIKE LAYOUT

The graph is NOT a force-directed floating graph (not Obsidian, not D3 
force simulation). It is a **spatially fixed, zoomable map** — like Google 
Maps, where every node has a deterministic (x, y) position that never moves.

---

### THE ANALOGY

- **Hierarchy root** (e.g., `Programming`) = Continent
- **Mid-level hierarchy** (e.g., `Python`) = Country  
- **Leaf hierarchy** (e.g., `Decorators`) = City
- **A Node (post)** = A landmark/building inside that city
- **Relations between Nodes** = Roads connecting landmarks
- **Zooming out** = you see continents (top-level topics)
- **Zooming in** = you see individual Node cards

This means: position is derived from hierarchy, not from physics.

---

### COORDINATE SYSTEM

Every hierarchy node and every post Node gets a stored `(x, y)` coordinate 
in the database. These are computed once on creation and never drift.

```sql
ALTER TABLE hierarchy_nodes ADD COLUMN x FLOAT NOT NULL DEFAULT 0;
ALTER TABLE hierarchy_nodes ADD COLUMN y FLOAT NOT NULL DEFAULT 0;
ALTER TABLE hierarchy_nodes ADD COLUMN radius FLOAT NOT NULL DEFAULT 500;
-- radius defines the spatial "territory" of this hierarchy cluster

ALTER TABLE nodes ADD COLUMN x FLOAT NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN y FLOAT NOT NULL DEFAULT 0;
```

---

### COORDINATE ASSIGNMENT ALGORITHM

Implement `src/services/layout.ts`:

**For hierarchy nodes (topics):**
- Root nodes are placed manually or evenly distributed on a large canvas 
  (e.g., 100,000 x 100,000 unit space)
- Children are placed in a **radial cluster** around their parent:
````

child_x = parent_x + radius * cos(2π * i / total_children)  
child_y = parent_y + radius * sin(2π * i / total_children)  
child_radius = parent_radius * 0.4

```
- Each level of hierarchy shrinks the radius by 60%
- Positions are computed and stored when a hierarchy node is created/approved

**For post Nodes:**
- Placed inside their hierarchy leaf cluster, again radially:
```

node_x = hierarchy_leaf_x + (leaf_radius * 0.3) * cos(2π * i / total_nodes)  
node_y = hierarchy_leaf_y + (leaf_radius * 0.3) * sin(2π * i / total_nodes)

```
- When a new Node is posted to a hierarchy, compute its position immediately 
  and store it. Never recompute existing positions.
- If a cluster gets too dense (> 50 nodes), trigger a 
  `layout:rebalance` queue job that redistributes positions within 
  the cluster boundary without touching other clusters.

---

### MAP VIEWPORT API
```

GET /api/v1/graph/viewport

```
Query params:
```

?x=50000&y=50000 ← center of current viewport  
&width=10000 ← visible canvas width in units  
&height=8000 ← visible canvas height in units  
&zoom=1.0 ← zoom level (0.1 = continent, 1.0 = city, 3.0 = node)

````

Returns only what is visible in the viewport + zoom level:
- `zoom < 0.3` → return hierarchy nodes only (continent/country level)
- `zoom 0.3–1.0` → return hierarchy leaves + node clusters as blobs
- `zoom > 1.0` → return individual post Nodes with full card data + edges

```json
{
  "data": {
    "viewport": { "x": 50000, "y": 50000, "width": 10000, "height": 8000, "zoom": 1.2 },
    "hierarchy_clusters": [
      { "id": "uuid", "label": "Python", "x": 51000, "y": 49500, "radius": 800, "node_count": 142 }
    ],
    "vertices": [
      { "id": "uuid", "title": "...", "x": 51200, "y": 49700, "hierarchy_path": [...] }
    ],
    "edges": [
      { "from": "uuid", "to": "uuid", "type": "extends" }
    ]
  }
}
```

This is the same pattern Google Maps uses — tiles load based on viewport, 
not the full world at once.
````

GET /api/v1/graph/cluster/:hierarchy_id

```
Returns all nodes + edges within a single hierarchy cluster. 
Used when user taps/clicks into a specific topic territory.

---

### FRONTEND CONTRACT FOR THE MAP

The map renderer (React Flow / Konva / custom Canvas) must:
- Use the stored `(x, y)` from the API — never compute positions client-side
- Implement pan (drag) + pinch/scroll zoom natively
- At low zoom: render hierarchy clusters as labeled circles (like country 
  borders on Google Maps)
- At mid zoom: render cluster with a node count badge
- At high zoom: render individual Node cards (title + cover image + 
  hierarchy tag)
- Edges render as curved paths between nodes (like roads), 
  colored by relation type:
  - `extends` → blue
  - `prerequisite` → green (directional arrow)
  - `contradicts` → red
  - `references` → grey
  - `see_also` → dashed grey
  - `inline` links → dotted, thinner weight

Never render all edges at once — only render edges for nodes 
currently in viewport.
```````
## WHAT TO BUILD

### 1. DATABASE SCHEMA (PostgreSQL + Redis)
Design and write the full schema for:
- `users` — auth, profile, reputation score
- `hierarchy_nodes` — the topic tree (self-referencing, adjacency list + 
  materialized path for fast traversal)
- `posts` (called `nodes` in product) — content packets with mandatory 
  hierarchy tag (FK to a leaf or mid-level `hierarchy_node`)
- `node_relations` — typed edges between posts (extends, contradicts, 
  references, is_part_of)
- `tags` — secondary folksonomy tags (not hierarchy, just searchability)
- `votes`, `bookmarks`, `follows` (follow a user OR a hierarchy branch)
- `ai_query_log` — tracks AI queries for feedback loop and dataset improvement
- `moderation_queue` — for new hierarchy branch proposals

Include: indexes, constraints, enums, triggers for `updated_at`, and a 
seed migration for the root hierarchy nodes.

### 2. BACKEND API (Node.js + TypeScript + Fastify)
Build a production-ready REST API with:

**Auth**
- JWT + refresh token flow (httpOnly cookie)
- OAuth2 stub (Google)

**Hierarchy**
- `GET /hierarchy` — full tree (cached in Redis, TTL 1hr)
- `GET /hierarchy/:id/children`
- `POST /hierarchy/propose` — submit new branch for moderation
- `PATCH /hierarchy/:id/approve` — moderator action

**Nodes (Posts)**
- `POST /nodes` — create a Node, must include `hierarchy_node_id`
- `GET /nodes/:id`
- `GET /nodes` — feed, filterable by hierarchy path, user, trending
- `PATCH /nodes/:id`
- `DELETE /nodes/:id`
- `POST /nodes/:id/relations` — link two Nodes with a typed relation

**Discovery & Feed**
- `GET /feed` — personalized feed based on followed branches + users
- `GET /hierarchy/:id/feed` — all Nodes under a hierarchy subtree
- `GET /search?q=` — full-text search (PostgreSQL tsvector)

**AI Query Endpoint**
- `POST /ai/query` — takes natural language query, retrieves top-k relevant 
  Nodes using pgvector similarity + hierarchy filter, returns composed answer 
  via Claude API (claude-sonnet-4-6), logs to `ai_query_log`

**Votes & Social**
- `POST /nodes/:id/vote`
- `POST /follow` — follow user or hierarchy branch
- `GET /users/:id/profile`

### 3. INFRASTRUCTURE LAYER
- Fastify plugin architecture (auth, db, redis, ai as plugins)
- Zod schema validation on all inputs
- Rate limiting (per-user and per-IP)
- Redis caching strategy: hierarchy tree, trending nodes, user feed cache
- Bull queue for: AI query processing, notification dispatch, 
  hierarchy approval events
- pgvector setup for Node embeddings (used by AI query)
- Environment config via `dotenv` + typed config object

### 4. PROJECT STRUCTURE
Output a complete folder structure and implement every file. Use:
- `src/plugins/` — db, redis, auth, ai
- `src/routes/` — one file per resource
- `src/schemas/` — Zod schemas
- `src/services/` — business logic separated from routes
- `src/workers/` — Bull queue workers
- `src/db/migrations/` — SQL migration files
- `src/types/` — shared TypeScript types
- `src/config.ts`
- `src/app.ts`
- `src/server.ts`

### 5. DEVOPS BASELINE
- `docker-compose.yml` with: postgres (pgvector image), redis, the API service
- `.env.example`
- Health check endpoint `GET /health`

---
---

## DEPLOYMENT PHILOSOPHY: FREE-TIER FIRST, SCALE-READY

### Current stage — zero infra cost:
- **Postgres** → Neon (free tier, serverless, supports pgvector natively)
- **Redis** → Upstash (free tier, serverless Redis, HTTP-compatible)
- **Queue** → Upstash QStash instead of Bull (no self-hosted worker process needed)
- **API hosting** → Railway or Render free tier (Fastify cold starts fine)
- **File/image storage** → Cloudinary free tier (Node body images, cover images)
- **Embeddings** → Voyage AI free tier or Anthropic embeddings (don't self-host)

### When you scale, swap only the adapter, not the architecture:
- Neon → Supabase dedicated or self-hosted Postgres (same pgvector queries)
- Upstash Redis → Redis Cloud or ElastiCache (same ioredis interface)
- QStash → Bull + Redis (same job interface, just swap the worker)
- Railway → Fly.io or AWS ECS (same Docker container, same env vars)
- Cloudinary → S3 + CloudFront (same upload service abstraction)

### Architecture rule:
Every infrastructure dependency must be behind a service abstraction layer 
(`src/services/storage.ts`, `src/services/queue.ts`, `src/services/cache.ts`).
Never call Cloudinary SDK or Upstash SDK directly from routes.
Routes call the service. The service calls the vendor.
Swapping vendors = changing one file.

---

## CROSS-PLATFORM API DESIGN

This API will be consumed by:
- **Web** (Next.js, browser)
- **iOS** (Swift, URLSession / Alamofire)
- **Android** (Kotlin, Retrofit)
- **Potentially third-party clients**

### Rules:
- Pure REST — no GraphQL, no tRPC, no Next.js-specific patterns
- All responses in a consistent JSON envelope:
```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "meta": { "page": 1, "total": 100 }  // only on paginated routes
}
```
- Auth via **Bearer token in Authorization header** — no cookie-only auth
  (cookies don't work cleanly on native mobile). Issue both:
  - `access_token` (15min) returned in response body
  - `refresh_token` (30 days) returned in response body
  Mobile stores in Keychain (iOS) / Keystore (Android). Web stores in memory 
  + httpOnly cookie optionally.
- All timestamps in **ISO 8601 UTC**
- Pagination via `?page=&limit=` cursor-based on feed endpoints
- CORS configured to allow all origins in dev, locked to your domains in prod
- No multipart form for file uploads — client uploads directly to Cloudinary 
  via signed URL. API provides the signed URL, never touches the binary.
- Versioned from day one: all routes under `/api/v1/`
## CONSTRAINTS
- TypeScript strict mode throughout
- No ORMs — raw SQL via `postgres` (the npm package) for full control
- Fastify, not Express
- Zod for all validation, no Joi
- Redis via `ioredis`
- Bull for queues
- pgvector for embeddings (`vector` column type)
- Claude API for AI query (`claude-sonnet-4-6`, streaming optional)
- JWT via `@fastify/jwt`
- Do NOT use Prisma, Drizzle, TypeORM, or Sequelize

---

## OUTPUT FORMAT
For each file: show the full path as a comment header, then the complete 
implementation. Do not truncate. Do not say "add your logic here." 
Implement it. Every route, every service method, every SQL query — real code.

Start with the DB schema and migrations, then infrastructure, 
then routes top-to-bottom, then workers, then docker setup.