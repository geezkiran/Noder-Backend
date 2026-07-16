# Noder Backend

A social network for context layers: users post **Nodes** — atomic packets of knowledge — organized in a living topic **hierarchy**, connected by a typed **graph**, rendered on a **spatially fixed, zoomable map**, and queryable through an **AI layer** (pgvector retrieval + Claude composition).

## Stack

- **API**: Node.js 20+, TypeScript (strict), Fastify 5
- **DB**: PostgreSQL + pgvector (raw SQL via `postgres`, no ORM)
- **Cache/queues**: Redis (ioredis) + Bull
- **Validation**: Zod on every input
- **AI**: Claude (`claude-sonnet-4-6`) for answer composition, Voyage AI for embeddings
- **Storage**: Cloudinary direct uploads via signed payloads (API never touches binaries)

Every vendor sits behind a service abstraction (`src/services/{cache,queue,storage,embeddings}.ts`) — swapping Neon→self-hosted PG, Upstash→ElastiCache, or Cloudinary→S3 changes one file each.

## Quick start (local)

```bash
cp .env.example .env               # fill in JWT_SECRET at minimum
docker compose up -d postgres redis
npm install
npm run migrate                    # applies src/db/migrations + seeds root hierarchy
npm run dev                        # API on :3000
npm run worker                     # Bull workers (embeddings, rebalance, notifications)
```

Or run everything in containers: `docker compose up --build`.

Works without `ANTHROPIC_API_KEY` / `VOYAGE_API_KEY` — `/ai/query` returns 503 until Claude is configured, and retrieval falls back to full-text search until embeddings are configured.

## API surface (all under `/api/v1`, Bearer auth)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `GET /auth/me`, `GET /auth/google` (stub) |
| Hierarchy | `GET /hierarchy` (cached tree), `GET /hierarchy/:id/children`, `GET /hierarchy/:id/feed`, `GET /hierarchy/:id/graph`, `POST /hierarchy/propose`, `PATCH /hierarchy/:id/approve` (mod) |
| Nodes | `GET/POST /nodes`, `GET/PATCH/DELETE /nodes/:id`, `POST /nodes/:id/vote`, `POST/DELETE /nodes/:id/bookmark` |
| Graph | `GET /nodes/:id/graph?depth=`, `GET /nodes/:id/prerequisites`, `GET /nodes/:id/related?type=`, `POST /nodes/:id/relations`, `DELETE /nodes/:id/relations/:relationId` |
| Map | `GET /graph/viewport?x=&y=&width=&height=&zoom=`, `GET /graph/cluster/:hierarchyId` |
| Discovery | `GET /feed`, `GET /feed/trending`, `GET /search?q=` |
| AI | `POST /ai/query`, `POST /ai/query/:queryId/feedback` |
| Social | `POST/DELETE /follow`, `GET /users/:id/profile`, `GET /users/:id/nodes` |
| Uploads | `POST /uploads/sign` (Cloudinary signed direct upload) |
| Ops | `GET /health` |

All responses use the envelope `{ "success": true, "data": ..., "error": null, "meta"?: { page, limit, total } }`.

## The map

Positions are deterministic and stored — never computed client-side, never drifting. Roots ring the center of a 100k×100k canvas; children are placed radially with radius shrinking 60% per level; post nodes ring their leaf cluster. Clusters denser than 50 nodes trigger a `layout-rebalance` queue job that redistributes only that cluster.

`GET /graph/viewport` is zoom-aware: `<0.3` returns continents/countries, `0.3–1.0` returns cluster blobs with node counts, `>1.0` returns full node cards + edges among visible nodes.

## Deployment (free-tier first)

Postgres → Neon · Redis → Upstash · API → Railway/Render · Images → Cloudinary · Embeddings → Voyage. Point `DATABASE_URL`/`REDIS_URL` at the managed services; the same Docker image runs anywhere.
# Noder-Backend
