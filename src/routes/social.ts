// src/routes/social.ts
// Follow a user OR a hierarchy branch.
import type { FastifyPluginAsync } from 'fastify';
import { followSchema } from '../schemas/social.js';
import { ok } from '../utils/envelope.js';

const socialRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/follow', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const input = followSchema.parse(request.body);
    const result = await fastify.services.social.follow(
      request.user.sub,
      input.target_type,
      input.target_id,
    );
    reply.code(201);
    return ok(result);
  });

  fastify.delete('/follow', { preHandler: [fastify.authenticate] }, async (request) => {
    const input = followSchema.parse(request.body);
    await fastify.services.social.unfollow(request.user.sub, input.target_type, input.target_id);
    return ok({ unfollowed: true });
  });
};

export default socialRoutes;
