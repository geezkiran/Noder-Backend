// src/services/auth.ts
// Register/login/refresh/logout. Access token = short-lived JWT (signed by the route
// via @fastify/jwt); refresh token = opaque random secret stored hashed with rotation.
import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { Sql } from 'postgres';
import { config } from '../config.js';
import type { JwtPayload, UserRole } from '../types/index.js';
import { badRequest, conflict, unauthorized } from '../utils/envelope.js';

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string;
  role: UserRole;
  reputation: number;
  created_at: string;
}

const PUBLIC_USER_COLUMNS = `
  id, email, username, display_name, avatar_url, bio, role, reputation, created_at
`;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AuthService {
  constructor(private readonly sql: Sql) {}

  async register(input: {
    email: string;
    username: string;
    password: string;
    display_name?: string;
  }): Promise<PublicUser> {
    const [taken] = await this.sql`
      SELECT id FROM users
      WHERE lower(email) = lower(${input.email}) OR lower(username) = lower(${input.username})
    `;
    if (taken) throw conflict('Email or username is already in use');

    const passwordHash = await bcrypt.hash(input.password, 12);
    const [user] = await this.sql<PublicUser[]>`
      INSERT INTO users (email, username, password_hash, display_name)
      VALUES (${input.email}, ${input.username}, ${passwordHash},
              ${input.display_name ?? input.username})
      RETURNING ${this.sql.unsafe(PUBLIC_USER_COLUMNS)}
    `;
    if (!user) throw new Error('Failed to create user');
    return user;
  }

  async login(email: string, password: string): Promise<PublicUser> {
    const [user] = await this.sql<Array<PublicUser & { password_hash: string | null }>>`
      SELECT ${this.sql.unsafe(PUBLIC_USER_COLUMNS)}, password_hash
      FROM users WHERE lower(email) = lower(${email})
    `;
    if (!user || !user.password_hash) throw unauthorized('Invalid email or password');

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw unauthorized('Invalid email or password');

    const { password_hash: _discard, ...publicUser } = user;
    return publicUser;
  }

  jwtPayloadFor(user: Pick<PublicUser, 'id' | 'role' | 'username'>): JwtPayload {
    return { sub: user.id, role: user.role, username: user.username };
  }

  /** Issue an opaque refresh token (stored hashed; 30-day expiry). */
  async issueRefreshToken(userId: string): Promise<string> {
    const token = randomBytes(48).toString('hex');
    const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 24 * 3600 * 1000);
    await this.sql`
      INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
      VALUES (${userId}, ${hashToken(token)}, ${expiresAt})
    `;
    return token;
  }

  /** Rotate: validate + revoke old, mint new, return the user for a fresh access JWT. */
  async rotateRefreshToken(token: string): Promise<{ user: PublicUser; refreshToken: string }> {
    if (!token) throw badRequest('refresh_token is required');

    const [row] = await this.sql<Array<{ id: string; user_id: string }>>`
      SELECT id, user_id FROM refresh_tokens
      WHERE token_hash = ${hashToken(token)}
        AND revoked_at IS NULL
        AND expires_at > now()
    `;
    if (!row) throw unauthorized('Invalid or expired refresh token');

    const [user] = await this.sql<PublicUser[]>`
      SELECT ${this.sql.unsafe(PUBLIC_USER_COLUMNS)} FROM users WHERE id = ${row.user_id}
    `;
    if (!user) throw unauthorized('User no longer exists');

    await this.sql`UPDATE refresh_tokens SET revoked_at = now() WHERE id = ${row.id}`;
    const refreshToken = await this.issueRefreshToken(user.id);

    return { user, refreshToken };
  }

  async revokeRefreshToken(token: string): Promise<void> {
    await this.sql`
      UPDATE refresh_tokens SET revoked_at = now()
      WHERE token_hash = ${hashToken(token)} AND revoked_at IS NULL
    `;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.sql`
      UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = ${userId} AND revoked_at IS NULL
    `;
  }

  /** Exchange a Google OAuth `code` for tokens, verify the ID token, upsert the user. */
  async loginWithGoogle(code: string): Promise<PublicUser> {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: config.google.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw unauthorized('Failed to exchange Google authorization code');
    const { id_token: idToken } = (await tokenRes.json()) as { id_token?: string };
    if (!idToken) throw unauthorized('Google did not return an ID token');

    // Verify the ID token against Google's tokeninfo endpoint (signature + audience + issuer).
    const verifyRes = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!verifyRes.ok) throw unauthorized('Invalid Google ID token');
    const claims = (await verifyRes.json()) as {
      aud?: string;
      sub?: string;
      email?: string;
      email_verified?: string | boolean;
      name?: string;
      picture?: string;
    };
    if (claims.aud !== config.google.clientId || !claims.sub || !claims.email) {
      throw unauthorized('Google ID token failed verification');
    }

    const picture = claims.picture ?? null;

    const [existing] = await this.sql<PublicUser[]>`
      SELECT ${this.sql.unsafe(PUBLIC_USER_COLUMNS)} FROM users WHERE google_id = ${claims.sub}
    `;
    if (existing) {
      // Backfill the Google profile photo for users who don't have an avatar yet.
      if (!existing.avatar_url && picture) {
        const [updated] = await this.sql<PublicUser[]>`
          UPDATE users SET avatar_url = ${picture}, updated_at = now()
          WHERE id = ${existing.id}
          RETURNING ${this.sql.unsafe(PUBLIC_USER_COLUMNS)}
        `;
        if (updated) return updated;
      }
      return existing;
    }

    const [byEmail] = await this.sql<PublicUser[]>`
      SELECT ${this.sql.unsafe(PUBLIC_USER_COLUMNS)} FROM users WHERE lower(email) = lower(${claims.email})
    `;
    if (byEmail) {
      const [linked] = await this.sql<PublicUser[]>`
        UPDATE users SET google_id = ${claims.sub},
                         avatar_url = COALESCE(avatar_url, ${picture}),
                         updated_at = now()
        WHERE id = ${byEmail.id}
        RETURNING ${this.sql.unsafe(PUBLIC_USER_COLUMNS)}
      `;
      if (!linked) throw new Error('Failed to link Google account');
      return linked;
    }

    const baseUsername = claims.email.split('@')[0]!.replace(/[^a-zA-Z0-9_]/g, '') || 'user';
    let username = baseUsername;
    for (let suffix = 0; ; suffix++) {
      const [taken] = await this.sql`SELECT id FROM users WHERE lower(username) = lower(${username})`;
      if (!taken) break;
      username = `${baseUsername}${suffix + 1}`;
    }

    const [created] = await this.sql<PublicUser[]>`
      INSERT INTO users (email, username, google_id, display_name, avatar_url)
      VALUES (${claims.email}, ${username}, ${claims.sub}, ${claims.name ?? username}, ${picture})
      RETURNING ${this.sql.unsafe(PUBLIC_USER_COLUMNS)}
    `;
    if (!created) throw new Error('Failed to create Google user');
    return created;
  }
}
