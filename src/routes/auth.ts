// src/routes/auth.ts
// JWT + refresh-token flow. Tokens are returned in the body (mobile stores in
// Keychain/Keystore); the refresh token is also set as an httpOnly cookie for web.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { loginSchema, refreshSchema, registerSchema } from '../schemas/auth.js';
import type { PublicUser } from '../services/auth.js';
import { config } from '../config.js';
import { badRequest, ok } from '../utils/envelope.js';

const REFRESH_COOKIE = 'refresh_token';

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: config.jwt.refreshTtlDays * 24 * 3600,
  });
}

const authRoutes: FastifyPluginAsync = async (fastify) => {
  const issueTokens = async (reply: FastifyReply, user: PublicUser) => {
    const accessToken = fastify.jwt.sign(fastify.services.auth.jwtPayloadFor(user));
    const refreshToken = await fastify.services.auth.issueRefreshToken(user.id);
    setRefreshCookie(reply, refreshToken);
    return {
      user,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 15 * 60,
    };
  };

  fastify.post('/auth/register', async (request, reply) => {
    const input = registerSchema.parse(request.body);
    const user = await fastify.services.auth.register(input);
    reply.code(201);
    return ok(await issueTokens(reply, user));
  });

  fastify.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const user = await fastify.services.auth.login(input.email, input.password);
      return ok(await issueTokens(reply, user));
    },
  );

  fastify.post('/auth/refresh', async (request, reply) => {
    const input = refreshSchema.parse(request.body ?? {});
    const token = input.refresh_token ?? request.cookies[REFRESH_COOKIE] ?? '';
    const { user, refreshToken } = await fastify.services.auth.rotateRefreshToken(token);
    const accessToken = fastify.jwt.sign(fastify.services.auth.jwtPayloadFor(user));
    setRefreshCookie(reply, refreshToken);
    return ok({
      user,
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 15 * 60,
    });
  });

  fastify.post('/auth/logout', { preHandler: [fastify.authenticate] }, async (request, reply) => {
    const input = refreshSchema.parse(request.body ?? {});
    const token = input.refresh_token ?? request.cookies[REFRESH_COOKIE];
    if (token) await fastify.services.auth.revokeRefreshToken(token);
    else await fastify.services.auth.revokeAllForUser(request.user.sub);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
    return ok({ logged_out: true });
  });

  fastify.get('/auth/me', { preHandler: [fastify.authenticate] }, async (request) => {
    const profile = await fastify.services.social.profile(request.user.sub);
    return ok(profile);
  });

  // ---- OAuth2 (Google) ----
  fastify.get('/auth/google', async () => {
    if (!config.google.clientId) {
      return ok({
        configured: false,
        message: 'Google OAuth is not configured. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.',
      });
    }
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: config.google.redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
    });
    return ok({
      configured: true,
      authorization_url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    });
  });

  fastify.get('/auth/google/callback', async (request, reply) => {
    const { code } = request.query as { code?: string };
    if (!config.google.clientId) {
      return ok({ configured: false, message: 'Google OAuth is not configured.' });
    }
    if (!code) throw badRequest('Missing ?code= from Google redirect');
    const user = await fastify.services.auth.loginWithGoogle(code);
    const tokens = await issueTokens(reply, user);
    const redirectUrl = new URL('/auth/callback', config.frontendUrl);
    redirectUrl.searchParams.set('access_token', tokens.access_token);
    redirectUrl.searchParams.set('refresh_token', tokens.refresh_token);
    redirectUrl.searchParams.set('expires_in', String(tokens.expires_in));
    return reply.redirect(redirectUrl.toString());
  });
};

export default authRoutes;
