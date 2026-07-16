// src/plugins/db.ts
// Raw SQL via the `postgres` package (no ORM). Decorates fastify.sql.
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import { config } from '../config.js';

declare module 'fastify' {
  interface FastifyInstance {
    sql: Sql;
  }
}

const dbPlugin: FastifyPluginAsync = async (fastify) => {
  const sql = postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });

  // Fail fast if the database is unreachable.
  await sql`SELECT 1`;

  fastify.decorate('sql', sql);
  fastify.addHook('onClose', async () => {
    await sql.end({ timeout: 5 });
  });
};

export default fp(dbPlugin, { name: 'db' });
