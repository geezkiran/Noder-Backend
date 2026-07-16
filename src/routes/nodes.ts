// src/routes/nodes.ts
// Node (post) CRUD + votes + relations + per-node graph endpoints.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { idParamSchema } from '../schemas/common.js';
import { createNodeSchema, listNodesSchema, updateNodeSchema, voteSchema } from '../schemas/nodes.js';
import { createRelationSchema, relatedQuerySchema } from '../schemas/relations.js';
import { egoGraphQuerySchema } from '../schemas/graph.js';
import { ok } from '../utils/envelope.js';

const relationParamsSchema = z.object({
  id: z.string().uuid(),
  relationId: z.string().uuid(),
});

const nodeRoutes: FastifyPluginAsync = async (fastify) => {
  // Feed listing: filter by hierarchy subtree / author, sort new|top|trending
  fastify.get('/nodes', async (request) => {
    const q = listNodesSchema.parse(request.query);
    if (q.sort === 'trending' && !q.hierarchy_id && !q.hierarchy_path && !q.author_id) {
      const items = await fastify.services.feed.trending(q.limit);
      return ok(items, { page: 1, limit: q.limit, total: items.length });
    }
    const { items, total } = await fastify.services.nodes.list(q);
    return ok(items, { page: q.page, limit: q.limit, total });
  });

  fastify.post('/nodes', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const input = createNodeSchema.parse(request.body);
    const node = await fastify.services.nodes.create(request.user.sub, input);
    reply.code(201);
    return ok(node);
  });

  fastify.get('/nodes/:id', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(await fastify.services.nodes.getById(id));
  });

  fastify.patch('/nodes/:id', { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const input = updateNodeSchema.parse(request.body);
    const node = await fastify.services.nodes.update(request.user.sub, request.user.role, id, input);
    return ok(node);
  });

  fastify.delete('/nodes/:id', { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    await fastify.services.nodes.softDelete(request.user.sub, request.user.role, id);
    return ok({ deleted: true });
  });

  // ---- votes ----
  fastify.post('/nodes/:id/vote', { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { value } = voteSchema.parse(request.body);
    const result = await fastify.services.social.vote(request.user.sub, id, value);
    return ok(result);
  });

  // ---- bookmarks ----
  fastify.post('/nodes/:id/bookmark', { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    await fastify.services.social.bookmark(request.user.sub, id, true);
    return ok({ bookmarked: true });
  });

  fastify.delete('/nodes/:id/bookmark', { preHandler: [fastify.authenticate] }, async (request) => {
    const { id } = idParamSchema.parse(request.params);
    await fastify.services.social.bookmark(request.user.sub, id, false);
    return ok({ bookmarked: false });
  });

  // ---- typed relations (graph edges) ----
  fastify.post('/nodes/:id/relations', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const input = createRelationSchema.parse(request.body);
    const relation = await fastify.services.relations.create(
      request.user.sub,
      id,
      input.to_node_id,
      input.relation_type,
    );
    reply.code(201);
    return ok(relation);
  });

  fastify.delete(
    '/nodes/:id/relations/:relationId',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { id, relationId } = relationParamsSchema.parse(request.params);
      await fastify.services.relations.remove(request.user.sub, request.user.role, id, relationId);
      return ok({ deleted: true });
    },
  );

  fastify.get('/nodes/:id/related', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { type } = relatedQuerySchema.parse(request.query);
    return ok(await fastify.services.graph.getRelatedNodes(id, type));
  });

  // ---- per-node graph views ----
  fastify.get('/nodes/:id/graph', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    const { depth } = egoGraphQuerySchema.parse(request.query);
    return ok(await fastify.services.graph.getEgoGraph(id, depth));
  });

  fastify.get('/nodes/:id/prerequisites', async (request) => {
    const { id } = idParamSchema.parse(request.params);
    return ok(await fastify.services.graph.getLearningPath(id));
  });
};

export default nodeRoutes;
