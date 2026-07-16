// src/schemas/auth.ts
import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(320),
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_]+$/, 'Username may contain letters, digits, and underscores'),
  password: z.string().min(8).max(128),
  display_name: z.string().max(80).optional(),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshSchema = z.object({
  refresh_token: z.string().min(1).optional(), // falls back to cookie
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
