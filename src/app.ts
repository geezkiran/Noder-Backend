// src/app.ts
// Builds the Fastify instance: plugins (db, redis, auth, ai, services),
// CORS, rate limiting, envelope-shaped error handling, and all /api/v1 routes.
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError, fail } from './utils/envelope.js';

import dbPlugin from './plugins/db.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import aiPlugin from './plugins/ai.js';
import servicesPlugin from './plugins/services.js';

import healthRoutes from './routes/health.js';
import authRoutes from './routes/auth.js';
import hierarchyRoutes from './routes/hierarchy.js';
import nodeRoutes from './routes/nodes.js';
import graphRoutes from './routes/graph.js';
import feedRoutes from './routes/feed.js';
import searchRoutes from './routes/search.js';
import aiRoutes from './routes/ai.js';
import socialRoutes from './routes/social.js';
import userRoutes from './routes/users.js';
import uploadRoutes from './routes/uploads.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.isProd ? 'info' : 'debug',
      transport: config.isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
    },
    trustProxy: true,
  });

  // ---- infrastructure plugins ----
  await app.register(dbPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(aiPlugin);
  await app.register(servicesPlugin);

  // ---- CORS: open in dev, locked to configured origins in prod ----
  await app.register(cors, {
    origin:
      config.corsOrigins === '*'
        ? true
        : config.corsOrigins.split(',').map((o) => o.trim()),
    credentials: true,
  });

  // ---- rate limiting: per-user when authenticated, per-IP otherwise (Redis-backed) ----
  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.window,
    redis: app.redis,
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      if (auth?.startsWith('Bearer ')) {
        try {
          const decoded = app.jwt.decode<{ sub?: string }>(auth.slice(7));
          if (decoded?.sub) return `user:${decoded.sub}`;
        } catch {
          /* fall through to IP */
        }
      }
      return `ip:${request.ip}`;
    },
  });

  // ---- envelope-shaped error handling ----
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      const message = error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return reply.code(400).send(fail('validation_error', message));
    }
    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send(fail(error.code, error.message));
    }
    const err = error as { statusCode?: number; code?: string; message?: string };
    if (err.statusCode === 429) {
      return reply.code(429).send(fail('rate_limited', 'Too many requests — slow down'));
    }
    if (typeof err.statusCode === 'number' && err.statusCode < 500) {
      return reply
        .code(err.statusCode)
        .send(fail(err.code ?? 'bad_request', err.message ?? 'Bad request'));
    }
    request.log.error(error);
    return reply.code(500).send(fail('internal_error', 'Something went wrong'));
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(fail('not_found', 'Route not found'));
  });

  // ---- routes (versioned from day one) ----
  await app.register(healthRoutes); // /health stays unversioned for load balancers
  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(hierarchyRoutes);
      await v1.register(nodeRoutes);
      await v1.register(graphRoutes);
      await v1.register(feedRoutes);
      await v1.register(searchRoutes);
      await v1.register(aiRoutes);
      await v1.register(socialRoutes);
      await v1.register(userRoutes);
      await v1.register(uploadRoutes);
    },
    { prefix: '/api/v1' },
  );

  return app;
}
