// src/routes/search.ts
import type { FastifyPluginAsync } from 'fastify';
import { searchQuerySchema } from '../schemas/search.js';
import { ok } from '../utils/envelope.js';

const searchRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/search', async (request) => {
    const q = searchQuerySchema.parse(request.query);
    const { items, total } = await fastify.services.search.search(
      q.q,
      q.hierarchy_id,
      q.page,
      q.limit,
    );
    return ok(items, { page: q.page, limit: q.limit, total });
  });
};

export default searchRoutes;
