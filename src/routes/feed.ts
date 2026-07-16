// src/routes/feed.ts
import type { FastifyPluginAsync } from 'fastify';
import { paginationSchema } from '../schemas/common.js';
import { ok } from '../utils/envelope.js';

const feedRoutes: FastifyPluginAsync = async (fastify) => {
  // Personalized feed: followed branches + followed users. Falls back to trending
  // for brand-new accounts that follow nothing yet.
  fastify.get('/feed', { preHandler: [fastify.authenticate] }, async (request) => {
    const { page, limit } = paginationSchema.parse(request.query);
    const { items, total } = await fastify.services.feed.personalized(request.user.sub, page, limit);
    if (total === 0 && page === 1) {
      const trending = await fastify.services.feed.trending(limit);
      return ok(trending, { page, limit, total: trending.length });
    }
    return ok(items, { page, limit, total });
  });

  fastify.get('/feed/trending', async (request) => {
    const { limit } = paginationSchema.parse(request.query);
    const items = await fastify.services.feed.trending(limit);
    return ok(items, { page: 1, limit, total: items.length });
  });
};

export default feedRoutes;
