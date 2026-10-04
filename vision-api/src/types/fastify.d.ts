/**
 * Fastify type augmentation.
 *
 * `app.visionService` is decorated in `buildServer()` so routes, tests and the
 * entrypoint can reach the analysis pipeline without a module-level singleton.
 * Declaring it here keeps `app` typed instead of `any`.
 *
 * `VisionServer` is the concrete instance type this service produces: Fastify
 * with a pino `Logger` (not the default `FastifyBaseLogger`). Route registrars
 * must accept *that* type, otherwise passing the real app to a helper typed as
 * a plain `FastifyInstance` fails to typecheck.
 */
import 'fastify';
import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { Logger } from 'pino';
import type { VisionService } from '../analyze/orchestrator.js';

declare module 'fastify' {
  interface FastifyInstance {
    visionService: VisionService;
  }
}

export type VisionServer = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger
>;