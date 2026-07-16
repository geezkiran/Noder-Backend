// src/routes/health.ts
import type { FastifyPluginAsync } from 'fastify';
import { ok } from '../utils/envelope.js';

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', { config: { rateLimit: false } }, async () => {
    const checks: Record<string, 'ok' | 'down'> = { postgres: 'down', redis: 'down' };
    try {
      await fastify.sql`SELECT 1`;
      checks.postgres = 'ok';
    } catch {
      /* reported below */
    }
    try {
      await fastify.redis.ping();
      checks.redis = 'ok';
    } catch {
      /* reported below */
    }
    return ok({ status: Object.values(checks).every((s) => s === 'ok') ? 'healthy' : 'degraded', checks });
  });
};

export default healthRoutes;
