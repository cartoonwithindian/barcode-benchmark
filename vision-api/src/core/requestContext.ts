/**
 * Request scoped context: request id + the pipeline stage a request is in.
 *
 * The stage marker is what allows the error handler to report *where* a request
 * failed (`failure_stage`) without wrapping every call site in try/catch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type PipelineStage =
  | 'received'
  | 'validated'
  | 'download'
  | 'decode'
  | 'preprocess'
  | 'barcode'
  | 'fusion'
  | 'ocr'
  | 'text'
  | 'respond';

export interface RequestContext {
  requestId: string;
  stage: PipelineStage;
  startedAt: bigint;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getContext(): RequestContext | undefined {
  return storage.getStore();
}

export function setStage(stage: PipelineStage): void {
  const ctx = storage.getStore();
  if (ctx) ctx.stage = stage;
}

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}