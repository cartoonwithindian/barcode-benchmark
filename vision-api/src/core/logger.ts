/**
 * Structured (JSON) logging built on pino, which Fastify already depends on.
 *
 * Rules enforced here:
 *  - one JSON object per line in production (Render log drain friendly),
 *  - secrets are redacted, never logged,
 *  - image URLs are logged in a redacted host-only form (see `safeUrlTag`).
 */
import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config/index.js';

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty: boolean;
  isProduction: boolean;
}

export function createLogger(config: AppConfig): Logger {
  const options: LoggerOptions = {
    level: config.server.logLevel,
    pretty: config.server.logPretty && !config.isProduction,
    isProduction: config.isProduction,
  };
  return build(options);
}

export function build(options: LoggerOptions): Logger {
  if (options.pretty) {
    return pino({
      level: options.level,
      transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } },
    });
  }
  return pino({
    level: options.level,
    base: { service: 'foodguard-vision-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers.cookie',
        'headers.authorization',
        'headers["x-api-key"]',
        '*.image_url',
        '*.imageUrl',
        'api_key',
        'apiKey',
      ],
      censor: '[redacted]',
    },
  });
}

/**
 * Reduces a URL to `host/path` without query string or credentials so product
 * URLs and signed-storage tokens never end up in logs.
 */
export function safeUrlTag(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300);
  } catch {
    return '[unparseable-url]';
  }
}

/** Logs a pipeline stage transition at debug level. */
export function stageLogger(log: Logger, stage: string, fields: Record<string, unknown> = {}): void {
  log.debug({ stage, ...fields }, 'stage');
}