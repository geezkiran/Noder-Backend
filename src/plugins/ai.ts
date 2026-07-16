// src/plugins/ai.ts
// Anthropic client as a plugin. Decorates fastify.anthropic.
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    anthropic: Anthropic | null;
  }
}

const aiPlugin: FastifyPluginAsync = async (fastify) => {
  // Without a key the /ai/query endpoint degrades gracefully (returns 503),
  // so local dev works without Anthropic credentials.
  const client = config.ai.apiKey ? new Anthropic({ apiKey: config.ai.apiKey }) : null;
  fastify.decorate('anthropic', client);
};

export default fp(aiPlugin, { name: 'ai' });
