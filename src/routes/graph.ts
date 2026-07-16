// src/routes/graph.ts
// Spatial map endpoints: viewport tiles (Google-Maps-style) + cluster drill-in.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { viewportQuerySchema } from '../schemas/graph.js';
import { ok } from '../utils/envelope.js';

const clusterParamsSchema = z.object({ hierarchyId: z.string().uuid() });

const graphRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/graph/viewport', async (request) => {
    const q = viewportQuerySchema.parse(request.query);
    return ok(await fastify.services.graph.getViewport(q));
  });

  fastify.get('/graph/cluster/:hierarchyId', async (request) => {
    const { hierarchyId } = clusterParamsSchema.parse(request.params);
    return ok(await fastify.services.graph.getHierarchyGraph(hierarchyId));
  });
};

export default graphRoutes;
