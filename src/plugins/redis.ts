// src/plugins/redis.ts
// ioredis client (same interface on local Redis and Upstash). Decorates fastify.redis.
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { Redis } from 'ioredis';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

const redisPlugin: FastifyPluginAsync = async (fastify) => {
  const redis = new Redis(config.redisUrl, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });

  await redis.connect();

  fastify.decorate('redis', redis);
  fastify.addHook('onClose', async () => {
    await redis.quit();
  });
};

export default fp(redisPlugin, { name: 'redis' });
