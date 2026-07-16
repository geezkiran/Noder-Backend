// src/config.ts
// Typed environment config. Fails fast at boot if required vars are missing.
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_REDIRECT_URI: z.string().default(''),

  FRONTEND_URL: z.string().default('http://localhost:3002'),

  ANTHROPIC_API_KEY: z.string().default(''),
  AI_MODEL: z.string().default('claude-sonnet-4-6'),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

  VOYAGE_API_KEY: z.string().default(''),
  EMBEDDING_MODEL: z.string().default('voyage-3'),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1024),

  CLOUDINARY_CLOUD_NAME: z.string().default(''),
  CLOUDINARY_API_KEY: z.string().default(''),
  CLOUDINARY_API_SECRET: z.string().default(''),

  CORS_ORIGINS: z.string().default('*'),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  env: parsed.data.NODE_ENV,
  isProd: parsed.data.NODE_ENV === 'production',
  host: parsed.data.HOST,
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL,
  redisUrl: parsed.data.REDIS_URL,
  jwt: {
    secret: parsed.data.JWT_SECRET,
    accessTtl: parsed.data.ACCESS_TOKEN_TTL,
    refreshTtlDays: parsed.data.REFRESH_TOKEN_TTL_DAYS,
  },
  google: {
    clientId: parsed.data.GOOGLE_CLIENT_ID,
    clientSecret: parsed.data.GOOGLE_CLIENT_SECRET,
    redirectUri: parsed.data.GOOGLE_REDIRECT_URI,
  },
  frontendUrl: parsed.data.FRONTEND_URL,
  ai: {
    apiKey: parsed.data.ANTHROPIC_API_KEY,
    model: parsed.data.AI_MODEL,
    maxTokens: parsed.data.AI_MAX_TOKENS,
  },
  embeddings: {
    apiKey: parsed.data.VOYAGE_API_KEY,
    model: parsed.data.EMBEDDING_MODEL,
    dim: parsed.data.EMBEDDING_DIM,
  },
  cloudinary: {
    cloudName: parsed.data.CLOUDINARY_CLOUD_NAME,
    apiKey: parsed.data.CLOUDINARY_API_KEY,
    apiSecret: parsed.data.CLOUDINARY_API_SECRET,
  },
  corsOrigins: parsed.data.CORS_ORIGINS,
  rateLimit: {
    max: parsed.data.RATE_LIMIT_MAX,
    window: parsed.data.RATE_LIMIT_WINDOW,
  },
} as const;

export type AppConfig = typeof config;
