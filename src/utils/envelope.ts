// src/utils/envelope.ts
// Consistent JSON envelope for every response:
// { success, data, error, meta? }
import type { ApiEnvelope, ApiMeta } from '../types/index.js';

export function ok<T>(data: T, meta?: ApiMeta): ApiEnvelope<T> {
  return meta === undefined
    ? { success: true, data, error: null }
    : { success: true, data, error: null, meta };
}

export function fail(code: string, message: string): ApiEnvelope<never> {
  return { success: false, data: null, error: { code, message } };
}

/** Error with an HTTP status the global error handler maps onto the envelope. */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (what = 'Resource'): ApiError =>
  new ApiError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string): ApiError =>
  new ApiError(400, 'bad_request', message);
export const unauthorized = (message = 'Authentication required'): ApiError =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'Insufficient permissions'): ApiError =>
  new ApiError(403, 'forbidden', message);
export const conflict = (message: string): ApiError =>
  new ApiError(409, 'conflict', message);
