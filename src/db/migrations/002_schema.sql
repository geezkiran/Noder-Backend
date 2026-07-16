-- src/db/migrations/002_schema.sql
-- Core schema for Noder: users, hierarchy, nodes (posts), graph edges, social, AI log.

-- ============================================================ enums

CREATE TYPE user_role AS ENUM ('user', 'moderator', 'admin');

CREATE TYPE node_relation_type AS ENUM (
  'extends',        -- this Node builds on that Node
  'contradicts',    -- this Node challenges that Node
  'references',     -- this Node cites that Node
  'is_part_of',     -- this Node is a chapter/section of that Node
  'prerequisite',   -- that Node should be read before this one
  'see_also'        -- loosely related, same topic space
);

CREATE TYPE moderation_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TYPE follow_target_type AS ENUM ('user', 'hierarchy');

-- ============================================================ users

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  username      TEXT NOT NULL,
  password_hash TEXT,                          -- null for OAuth-only accounts
  google_id     TEXT UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT,
  bio           TEXT NOT NULL DEFAULT '',
  role          user_role NOT NULL DEFAULT 'user',
  reputation    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_username_key ON users (lower(username));

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- ============================================================ hierarchy (topic tree)
-- Adjacency list (parent_id) + materialized path (path) for fast subtree queries.
-- Spatial columns give each topic a fixed territory on the 100,000 x 100,000 map.

CREATE TABLE hierarchy_nodes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id   UUID REFERENCES hierarchy_nodes(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL,
  path        TEXT NOT NULL,                   -- e.g. 'programming/python/decorators'
  depth       INTEGER NOT NULL DEFAULT 0,
  status      moderation_status NOT NULL DEFAULT 'approved',
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  x           DOUBLE PRECISION NOT NULL DEFAULT 0,
  y           DOUBLE PRECISION NOT NULL DEFAULT 0,
  radius      DOUBLE PRECISION NOT NULL DEFAULT 500,
  node_count  INTEGER NOT NULL DEFAULT 0,      -- direct post-node count (rebalance trigger threshold)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (parent_id, slug)
);

CREATE UNIQUE INDEX hierarchy_nodes_path_key ON hierarchy_nodes (path);
CREATE INDEX hierarchy_nodes_path_prefix_idx ON hierarchy_nodes (path text_pattern_ops);
CREATE INDEX hierarchy_nodes_parent_idx ON hierarchy_nodes (parent_id);
CREATE INDEX hierarchy_nodes_status_idx ON hierarchy_nodes (status) WHERE status <> 'approved';
CREATE INDEX hierarchy_nodes_spatial_idx ON hierarchy_nodes (x, y);

-- ============================================================ nodes (posts)

CREATE TABLE nodes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hierarchy_node_id UUID NOT NULL REFERENCES hierarchy_nodes(id) ON DELETE RESTRICT,
  title             VARCHAR(120) NOT NULL,
  summary           VARCHAR(280),
  cover_image       TEXT,
  body              JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ordered block array, Zod-validated on ingest
  hierarchy_path    TEXT[] NOT NULL DEFAULT '{}',          -- denormalized display chain, e.g. {Programming,Python,Decorators}
  x                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  y                 DOUBLE PRECISION NOT NULL DEFAULT 0,
  vote_count        INTEGER NOT NULL DEFAULT 0,
  bookmark_count    INTEGER NOT NULL DEFAULT 0,
  relation_count    INTEGER NOT NULL DEFAULT 0,
  tsv               TSVECTOR,
  embedding         VECTOR(1024),                           -- voyage-3; title + summary + text/code blocks
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX nodes_hierarchy_idx   ON nodes (hierarchy_node_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX nodes_author_idx      ON nodes (author_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX nodes_created_idx     ON nodes (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX nodes_trending_idx    ON nodes (vote_count DESC, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX nodes_tsv_idx         ON nodes USING gin (tsv);
CREATE INDEX nodes_spatial_idx     ON nodes (x, y) WHERE deleted_at IS NULL;
CREATE INDEX nodes_embedding_idx   ON nodes USING hnsw (embedding vector_cosine_ops);

-- ============================================================ graph edges

CREATE TABLE node_relations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_node_id  UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_node_id    UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  relation_type node_relation_type NOT NULL,
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_node_id, to_node_id, relation_type),
  CHECK (from_node_id <> to_node_id)
);

CREATE INDEX node_relations_from_idx ON node_relations (from_node_id);
CREATE INDEX node_relations_to_idx   ON node_relations (to_node_id);

-- Inline [[node:uuid]] links extracted from body text blocks (soft edges).
CREATE TABLE node_inline_links (
  from_node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_node_id   UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (from_node_id, to_node_id)
);

CREATE INDEX node_inline_links_to_idx ON node_inline_links (to_node_id);

-- ============================================================ tags (folksonomy, not hierarchy)

CREATE TABLE tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tags_name_key ON tags (lower(name));

CREATE TABLE node_tags (
  node_id UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  tag_id  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, tag_id)
);

CREATE INDEX node_tags_tag_idx ON node_tags (tag_id);

-- ============================================================ social

CREATE TABLE votes (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id    UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  value      SMALLINT NOT NULL CHECK (value IN (-1, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, node_id)
);

CREATE INDEX votes_node_idx ON votes (node_id);

CREATE TABLE bookmarks (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id    UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, node_id)
);

CREATE INDEX bookmarks_node_idx ON bookmarks (node_id);

-- Follow a user OR a hierarchy branch (exactly one target set).
CREATE TABLE follows (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type         follow_target_type NOT NULL,
  target_user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  target_hierarchy_id UUID REFERENCES hierarchy_nodes(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (target_type = 'user'      AND target_user_id IS NOT NULL AND target_hierarchy_id IS NULL) OR
    (target_type = 'hierarchy' AND target_hierarchy_id IS NOT NULL AND target_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX follows_user_target_key      ON follows (follower_id, target_user_id) WHERE target_type = 'user';
CREATE UNIQUE INDEX follows_hierarchy_target_key ON follows (follower_id, target_hierarchy_id) WHERE target_type = 'hierarchy';
CREATE INDEX follows_follower_idx ON follows (follower_id);

-- ============================================================ AI query log (feedback loop / dataset improvement)

CREATE TABLE ai_query_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  query              TEXT NOT NULL,
  hierarchy_node_id  UUID REFERENCES hierarchy_nodes(id) ON DELETE SET NULL,
  retrieved_node_ids UUID[] NOT NULL DEFAULT '{}',
  answer             TEXT,
  model              TEXT NOT NULL,
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  latency_ms         INTEGER,
  feedback           SMALLINT CHECK (feedback IN (-1, 1)),  -- thumbs up/down, set later
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ai_query_log_user_idx    ON ai_query_log (user_id, created_at DESC);
CREATE INDEX ai_query_log_created_idx ON ai_query_log (created_at DESC);

-- ============================================================ moderation queue (hierarchy branch proposals)

CREATE TABLE moderation_queue (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_type         TEXT NOT NULL DEFAULT 'hierarchy_proposal',
  hierarchy_node_id UUID REFERENCES hierarchy_nodes(id) ON DELETE CASCADE,
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_by       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status            moderation_status NOT NULL DEFAULT 'pending',
  reviewed_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX moderation_queue_status_idx ON moderation_queue (status, created_at);

-- ============================================================ triggers

-- updated_at maintenance
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at           BEFORE UPDATE ON users           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER hierarchy_nodes_updated_at BEFORE UPDATE ON hierarchy_nodes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER nodes_updated_at           BEFORE UPDATE ON nodes           FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- full-text search vector: title weighted A, summary weighted B
CREATE OR REPLACE FUNCTION nodes_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.summary, '')), 'B');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER nodes_tsv BEFORE INSERT OR UPDATE OF title, summary ON nodes
  FOR EACH ROW EXECUTE FUNCTION nodes_tsv_update();

-- denormalized vote_count on nodes
CREATE OR REPLACE FUNCTION votes_apply() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE nodes SET vote_count = vote_count + NEW.value WHERE id = NEW.node_id;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE nodes SET vote_count = vote_count - OLD.value + NEW.value WHERE id = NEW.node_id;
    RETURN NEW;
  ELSE
    UPDATE nodes SET vote_count = vote_count - OLD.value WHERE id = OLD.node_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER votes_counter AFTER INSERT OR UPDATE OR DELETE ON votes
  FOR EACH ROW EXECUTE FUNCTION votes_apply();

-- denormalized bookmark_count
CREATE OR REPLACE FUNCTION bookmarks_apply() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE nodes SET bookmark_count = bookmark_count + 1 WHERE id = NEW.node_id;
    RETURN NEW;
  ELSE
    UPDATE nodes SET bookmark_count = bookmark_count - 1 WHERE id = OLD.node_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookmarks_counter AFTER INSERT OR DELETE ON bookmarks
  FOR EACH ROW EXECUTE FUNCTION bookmarks_apply();

-- denormalized relation_count on both endpoints
CREATE OR REPLACE FUNCTION relations_apply() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE nodes SET relation_count = relation_count + 1 WHERE id IN (NEW.from_node_id, NEW.to_node_id);
    RETURN NEW;
  ELSE
    UPDATE nodes SET relation_count = relation_count - 1 WHERE id IN (OLD.from_node_id, OLD.to_node_id);
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER relations_counter AFTER INSERT OR DELETE ON node_relations
  FOR EACH ROW EXECUTE FUNCTION relations_apply();

-- hierarchy cluster density counter (drives layout:rebalance queue job at > 50)
CREATE OR REPLACE FUNCTION hierarchy_node_count_apply() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE hierarchy_nodes SET node_count = node_count + 1 WHERE id = NEW.hierarchy_node_id;
    RETURN NEW;
  ELSE
    UPDATE hierarchy_nodes SET node_count = node_count - 1 WHERE id = OLD.hierarchy_node_id;
    RETURN OLD;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hierarchy_node_counter AFTER INSERT OR DELETE ON nodes
  FOR EACH ROW EXECUTE FUNCTION hierarchy_node_count_apply();
