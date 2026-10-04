/**
 * API key authentication.
 *
 * Two accepted header forms, both optional depending on configuration:
 *   `X-API-Key: <key>`            (preferred, explicit)
 *   `Authorization: Bearer <key>`
 *
 * Behaviour:
 *  - when `API_KEYS` is empty the service starts *without* authentication and
 *    says so loudly at boot and on `/version` (`auth_enabled: false`), because
 *    an unauthenticated deployment is a deployment the operator chose;
 *  - keys are compared in constant time;
 *  - failures return 401 with a stable code and never echo the supplied key.
 */
import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, ErrorCode } from '../core/errors.js';
import { globalMetrics } from '../core/metrics.js';
import type { AppConfig } from '../config/index.js';

function constantTimeEquals(a: string, b: string): boolean {
  // Hashing first keeps the inputs the same length, so the comparison is a plain
  // constant-time equality without leaking the key length.
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function extractApiKey(request: FastifyRequest): string | null {
  const header = request.headers['x-api-key'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0] ?? null;

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function createAuthHook(config: AppConfig) {
  return async function authHook(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!config.security.authRequired) return;

    const supplied = extractApiKey(request);
    if (!supplied) {
      globalMetrics.increment('unauthorized_total');
      throw new AppError(ErrorCode.UNAUTHORIZED, 'A valid API key is required.');
    }

    const authorised = config.security.apiKeys.some((key) => constantTimeEquals(key, supplied));
    if (!authorised) {
      globalMetrics.increment('unauthorized_total');
      throw new AppError(ErrorCode.UNAUTHORIZED, 'A valid API key is required.');
    }
  };
}
