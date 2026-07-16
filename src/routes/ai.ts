// src/routes/ai.ts
// Natural-language querying over the knowledge graph. Rate-limited tighter than
// the global limit since each call costs an embedding + a Claude completion.
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { aiFeedbackSchema, aiQuerySchema } from '../schemas/ai.js';
import { ok } from '../utils/envelope.js';

const feedbackParamsSchema = z.object({ queryId: z.string().uuid() });

const aiRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/ai/query',
    {
      preHandler: [fastify.authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (request) => {
      const input = aiQuerySchema.parse(request.body);
      const result = await fastify.services.ai.query(
        request.user.sub,
        input.query,
        input.hierarchy_node_id,
        input.top_k,
      );
      return ok(result);
    },
  );

  // Thumbs up/down feeds the dataset-improvement loop.
  fastify.post(
    '/ai/query/:queryId/feedback',
    { preHandler: [fastify.authenticate] },
    async (request) => {
      const { queryId } = feedbackParamsSchema.parse(request.params);
      const { feedback } = aiFeedbackSchema.parse(request.body);
      await fastify.services.ai.feedback(request.user.sub, queryId, feedback);
      return ok({ recorded: true });
    },
  );
};

export default aiRoutes;
