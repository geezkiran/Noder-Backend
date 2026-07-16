// src/plugins/auth.ts
// JWT bearer auth (mobile-friendly) + optional httpOnly cookie for web.
// Decorates fastify.authenticate (required) and fastify.optionalAuth.
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { config } from '../config.js';
import { unauthorized } from '../utils/envelope.js';
import type { JwtPayload } from '../types/index.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtPayload;
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireModerator: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  await fastify.register(cookie);
  await fastify.register(jwt, {
    secret: config.jwt.secret,
    sign: { expiresIn: config.jwt.accessTtl },
    // Bearer header is primary; cookie is a web convenience fallback.
    cookie: { cookieName: 'access_token', signed: false },
  });

  fastify.decorate('authenticate', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Missing or invalid access token');
    }
  });

  fastify.decorate('optionalAuth', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      // anonymous is fine
    }
  });

  fastify.decorate('requireModerator', async (request: FastifyRequest) => {
    try {
      await request.jwtVerify();
    } catch {
      throw unauthorized('Missing or invalid access token');
    }
    if (request.user.role !== 'moderator' && request.user.role !== 'admin') {
      throw unauthorized('Moderator role required');
    }
  });
};

export default fp(authPlugin, { name: 'auth' });
