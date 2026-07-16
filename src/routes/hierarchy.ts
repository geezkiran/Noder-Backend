// src/routes/hierarchy.ts
import type { FastifyPluginAsync } from 'fastify';
import { idParamSchema, paginationSchema } from '../schemas/common.js';
import { approveBranchSchema, proposeBranchSchema } from '../schemas/hierarchy.js';
import { ok } from '../utils/envelope.js';

const hierarchyRoutes: FastifyPluginAsync = async (fastify) => {
  // Full approved tree (Redis-cached, 1hr TTL)
  fastify.get('/hierarchy', async () => {
    const tree = await fastify.services.hierarchy.getTree();
    return ok(tree);
  });

  fastify.get('/hierarchy/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(await fastify.services.hierarchy.getById(id));
  });

  fastify.get('/hierarchy/:id/children', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(await fastify.services.hierarchy.getChildren(id));
  });

  // Feed of all nodes under a hierarchy subtree
  fastify.get('/hierarchy/:id/feed', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { page, limit } = paginationSchema.parse(request.query);
    const { items, total } = await fastify.services.feed.hierarchyFeed(id, page, limit);
    return ok(items, { page, limit, total });
  });

  // Knowledge graph of an entire subtree
  fastify.get('/hierarchy/:id/graph', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(await fastify.services.graph.getHierarchyGraph(id));
  });

  // Propose a new branch (goes to the moderation queue)
  fastify.post(
    '/hierarchy/propose',
    { preHandler: [fastify.authenticate] },
    async (request, reply) => {
      const input = proposeBranchSchema.parse(request.body);
      const result = await fastify.services.hierarchy.propose(request.user.sub, input);
      reply.code(201);
      return ok(result);
    },
  );

  // Moderator: approve or reject a pending branch
  fastify.patch(
    '/hierarchy/:id/approve',
    { preHandler: [fastify.requireModerator] },
    async (request) => {
      const { id } = idParamSchema.parse(request.params);
      const { decision } = approveBranchSchema.parse(request.body ?? {});
      const node = await fastify.services.hierarchy.review(request.user.sub, id, decision);
      return ok(node);
    },
  );

  // Moderator: pending proposals
  fastify.get(
    '/hierarchy/moderation/pending',
    { preHandler: [fastify.requireModerator] },
    async () => {
      return ok(await fastify.services.hierarchy.listPending());
    },
  );
};

export default hierarchyRoutes;
