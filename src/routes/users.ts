// src/routes/users.ts
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { paginationSchema } from '../schemas/common.js';
import { listNodesSchema } from '../schemas/nodes.js';
import { ok } from '../utils/envelope.js';

const userParamsSchema = z.object({ id: z.string().uuid() });

const userRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/users/:id/profile', async (request) => {
    const { id } = userParamsSchema.parse(request.params);
    return ok(await fastify.services.social.profile(id));
  });

  fastify.get('/users/:id/nodes', async (request) => {
    const { id } = userParamsSchema.parse(request.params);
    const { page, limit } = paginationSchema.parse(request.query);
    const q = listNodesSchema.parse({ page, limit, author_id: id, sort: 'new' });
    const { items, total } = await fastify.services.nodes.list(q);
    return ok(items, { page, limit, total });
  });
};

export default userRoutes;
