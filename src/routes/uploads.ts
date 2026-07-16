// src/routes/uploads.ts
// The API never touches file binaries: it issues a signed payload and the client
// uploads directly to Cloudinary (swap-ready for S3 presigned POSTs).
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { ok } from '../utils/envelope.js';

const signSchema = z.object({
  purpose: z.enum(['covers', 'body-images']).default('body-images'),
});

const uploadRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/uploads/sign', { preHandler: [fastify.authenticate] }, async (request) => {
    const { purpose } = signSchema.parse(request.body ?? {});
    const signed = fastify.services.storage.signUpload(purpose, request.user.sub);
    return ok(signed);
  });
};

export default uploadRoutes;
