-- src/db/migrations/003_seed_hierarchy.sql
-- Root hierarchy nodes ("continents") evenly distributed on the 100,000 x 100,000 canvas,
-- plus one worked branch (Programming > Python > ...) so the map isn't empty on day one.
--
-- Roots sit on a ring of radius 30,000 around canvas center (50000, 50000).
-- Children are placed radially: child_radius = parent_radius * 0.4.

WITH roots(name, slug, ordinal) AS (
  VALUES
    ('Programming', 'programming', 0),
    ('Science',     'science',     1),
    ('Mathematics', 'mathematics', 2),
    ('Design',      'design',      3),
    ('Business',    'business',    4),
    ('Philosophy',  'philosophy',  5),
    ('Health',      'health',      6),
    ('History',     'history',     7)
)
INSERT INTO hierarchy_nodes (name, slug, path, depth, status, x, y, radius)
SELECT
  name,
  slug,
  slug,
  0,
  'approved',
  50000 + 30000 * cos(2 * pi() * ordinal / 8.0),
  50000 + 30000 * sin(2 * pi() * ordinal / 8.0),
  8000
FROM roots;

-- Programming > {Python, JavaScript, Databases, Systems}
WITH parent AS (SELECT * FROM hierarchy_nodes WHERE path = 'programming'),
     kids(name, slug, ordinal, total) AS (
       VALUES
         ('Python',     'python',     0, 4),
         ('JavaScript', 'javascript', 1, 4),
         ('Databases',  'databases',  2, 4),
         ('Systems',    'systems',    3, 4)
     )
INSERT INTO hierarchy_nodes (parent_id, name, slug, path, depth, status, x, y, radius)
SELECT
  p.id,
  k.name,
  k.slug,
  p.path || '/' || k.slug,
  p.depth + 1,
  'approved',
  p.x + p.radius * cos(2 * pi() * k.ordinal / k.total),
  p.y + p.radius * sin(2 * pi() * k.ordinal / k.total),
  p.radius * 0.4
FROM parent p CROSS JOIN kids k;

-- Programming > Python > {Decorators, Async, Typing}
WITH parent AS (SELECT * FROM hierarchy_nodes WHERE path = 'programming/python'),
     kids(name, slug, ordinal, total) AS (
       VALUES
         ('Decorators', 'decorators', 0, 3),
         ('Async',      'async',      1, 3),
         ('Typing',     'typing',     2, 3)
     )
INSERT INTO hierarchy_nodes (parent_id, name, slug, path, depth, status, x, y, radius)
SELECT
  p.id,
  k.name,
  k.slug,
  p.path || '/' || k.slug,
  p.depth + 1,
  'approved',
  p.x + p.radius * cos(2 * pi() * k.ordinal / k.total),
  p.y + p.radius * sin(2 * pi() * k.ordinal / k.total),
  p.radius * 0.4
FROM parent p CROSS JOIN kids k;
