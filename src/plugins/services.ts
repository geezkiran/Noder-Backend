// src/plugins/services.ts
// Instantiates the service layer once and decorates fastify.services.
// Routes depend on this; services depend on db/redis/ai plugins.
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { AiService } from '../services/ai.js';
import { AuthService } from '../services/auth.js';
import { CacheService } from '../services/cache.js';
import { FeedService } from '../services/feed.js';
import { GraphService } from '../services/graph.js';
import { HierarchyService } from '../services/hierarchy.js';
import { NodeService } from '../services/nodes.js';
import { QueueService } from '../services/queue.js';
import { RelationService } from '../services/relations.js';
import { SearchService } from '../services/search.js';
import { SocialService } from '../services/social.js';
import { StorageService } from '../services/storage.js';

export interface Services {
  cache: CacheService;
  queue: QueueService;
  storage: StorageService;
  auth: AuthService;
  hierarchy: HierarchyService;
  nodes: NodeService;
  relations: RelationService;
  graph: GraphService;
  feed: FeedService;
  search: SearchService;
  ai: AiService;
  social: SocialService;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: Services;
  }
}

const servicesPlugin: FastifyPluginAsync = async (fastify) => {
  const cache = new CacheService(fastify.redis);
  const queue = new QueueService();

  const services: Services = {
    cache,
    queue,
    storage: new StorageService(),
    auth: new AuthService(fastify.sql),
    hierarchy: new HierarchyService(fastify.sql, cache, queue),
    nodes: new NodeService(fastify.sql, cache, queue),
    relations: new RelationService(fastify.sql, queue),
    graph: new GraphService(fastify.sql),
    feed: new FeedService(fastify.sql, cache),
    search: new SearchService(fastify.sql),
    ai: new AiService(fastify.sql, fastify.anthropic),
    social: new SocialService(fastify.sql),
  };

  fastify.decorate('services', services);
  fastify.addHook('onClose', async () => {
    await queue.close();
  });
};

export default fp(servicesPlugin, { name: 'services', dependencies: ['db', 'redis', 'ai'] });
