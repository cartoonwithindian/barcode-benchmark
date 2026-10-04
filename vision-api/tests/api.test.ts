import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ImageServer, startImageServer, withEnv, TEST_ENV, TEST_API_KEY } from './helpers.js';
import { buildServer } from '../src/server.js';
import { loadConfig } from '../src/config/index.js';
import { silentLogger } from './helpers.js';
import { ErrorCode } from '../src/core/errors.js';

const BASE_ENV = { ...TEST_ENV };

describe('API tests', () => {
  let imgServer: ImageServer;

  beforeAll(async () => {
    imgServer = await startImageServer();
  }, 30000);

  afterAll(async () => {
    await imgServer.close();
  });

  describe('GET /health', () => {
    it('returns 200, fast, with status, and does not depend on OCR/download', async () => {
      const config = loadConfig({ ...BASE_ENV });
      const app = await buildServer({ config, logger: silentLogger() });
      try {
        const res = await app.inject({ method: 'GET', url: '/health' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('status');
        expect(typeof body.status).toBe('string');
        expect(res.headers).toHaveProperty('x-request-id');
      } finally {
        await app.close();
        await app.visionService.close();
      }
    });
  });

  describe('GET /version', () => {
    it('returns 200 with version string and schema/api version fields', async () => {
      const config = loadConfig({ ...BASE_ENV });
      const app = await buildServer({ config, logger: silentLogger() });
      try {
        const res = await app.inject({ method: 'GET', url: '/version' });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body).toHaveProperty('version');
        expect(typeof body.version).toBe('string');
        expect(body).toHaveProperty('schema_version');
        expect(body).toHaveProperty('api_version');
      } finally {
        await app.close();
        await app.visionService.close();
      }
    });
  });

  describe('GET /metrics', () => {
    it('returns 200 metrics by default', async () => {
      const config = loadConfig({ ...BASE_ENV });
      const app = await buildServer({ config, logger: silentLogger() });
      try {
        const res = await app.inject({ method: 'GET', url: '/metrics' });
        expect(res.statusCode).toBe(200);
      } finally {
        await app.close();
        await app.visionService.close();
      }
    });

    it('honours EXPOSE_METRICS=false', async () => {
      await withEnv({ ...BASE_ENV, EXPOSE_METRICS: 'false' }, async () => {
        const config = loadConfig();
        const app = await buildServer({ config, logger: silentLogger() });
        try {
          const res = await app.inject({ method: 'GET', url: '/metrics' });
          expect(res.statusCode).toBe(404);
          const body = res.json();
          expect(body).toHaveProperty('error');
        } finally {
          await app.close();
          await app.visionService.close();
        }
      });
    });
  });

  describe('POST /v1/analyze happy paths', () => {
    it('happy path against barcode-ean13.png', async () => {
      const port = new URL(imgServer.origin).port;
      const env = {
        ...BASE_ENV,
        ALLOWED_URL_PORTS: port,
        OCR_ENABLED: 'false',
      };
      await withEnv(env, async () => {
        const config = loadConfig();
        const app = await buildServer({ config, logger: silentLogger() });
        try {
          const imageUrl = imgServer.url('barcode-ean13.png');
          const res = await app.inject({
            method: 'POST',
            url: '/v1/analyze',
            headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
            payload: { image_url: imageUrl },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body).toHaveProperty('schema_version');
          expect(body).toHaveProperty('api_version');
          expect(body).toHaveProperty('request_id');
          expect(body).toHaveProperty('barcode');
          expect(body).toHaveProperty('ocr');
          expect(body).toHaveProperty('signals');
          expect(body).toHaveProperty('diagnostics');
          expect(body.barcode.detected).toBe(true);
          expect(body.barcode.primary).not.toBeNull();
          expect(body.barcode.primary.value).toBe('8901262260121');
          expect(body.barcode.primary.confidence_source).toBe('derived');
          expect(body.ocr).toHaveProperty('raw_text');
          expect(body.ocr).toHaveProperty('normalized_text');
        } finally {
          await app.close();
          await app.visionService.close();
        }
      });
    }, 60000);
  });

  describe('No fabrication contract', () => {
    it('blank-page.png -> barcode.detected false, no fabrication, OCR empty', async () => {
      const port = new URL(imgServer.origin).port;
      const env = {
        ...BASE_ENV,
        ALLOWED_URL_PORTS: port,
        OCR_ENABLED: 'false',
      };
      await withEnv(env, async () => {
        const config = loadConfig();
        const app = await buildServer({ config, logger: silentLogger() });
        try {
          const imageUrl = imgServer.url('blank-page.png');
          const res = await app.inject({
            method: 'POST',
            url: '/v1/analyze',
            headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
            payload: { image_url: imageUrl },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          expect(body.barcode.detected).toBe(false);
          expect(body.barcode.primary).toBeNull();
          expect(body.ocr.detected).toBe(false);
          expect(body.ocr.raw_text).toBe('');
          expect(body.ocr.normalized_text).toBe('');
        } finally {
          await app.close();
          await app.visionService.close();
        }
      });
    }, 60000);
  });

  describe('Invalid image and error envelope', () => {
    it('not-an-image.txt served as image gives non-2xx with structured error envelope', async () => {
      const port = new URL(imgServer.origin).port;
      const env = {
        ...BASE_ENV,
        ALLOWED_URL_PORTS: port,
      };
      await withEnv(env, async () => {
        const config = loadConfig();
        const app = await buildServer({ config, logger: silentLogger() });
        try {
          const imageUrl = imgServer.url('not-an-image.txt');
          const res = await app.inject({
            method: 'POST',
            url: '/v1/analyze',
            headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
            payload: { image_url: imageUrl },
          });
          expect(res.statusCode).not.toBe(200);
          const body = res.json();
          expect(body).toHaveProperty('error');
          expect(body.error).toHaveProperty('code');
          expect(body.error).toHaveProperty('message');
          expect(body).toHaveProperty('request_id');
        } finally {
          await app.close();
          await app.visionService.close();
        }
      });
    }, 60000);

    it('returns 429 (not 500) once the rate limit is exhausted', async () => {
      const port = new URL(imgServer.origin).port;
      const env = { ...BASE_ENV, ALLOWED_URL_PORTS: port, RATE_LIMIT_MAX: '3' };
      await withEnv(env, async () => {
        const config = loadConfig();
        const app = await buildServer({ config, logger: silentLogger() });
        try {
          const request = () =>
            app.inject({
              method: 'POST',
              url: '/v1/analyze',
              headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
              payload: {},
            });
          for (let i = 0; i < 3; i++) await request();
          const limited = await request();
          expect(limited.statusCode).toBe(429);
          const body = limited.json();
          expect(body.success).toBe(false);
          expect(body.error.code).toBe(ErrorCode.RATE_LIMITED);
          expect(body.error.retry_after_seconds).toBeGreaterThan(0);
          expect(body.request_id).toBeTruthy();
          // The health endpoint must stay reachable while a client is limited,
          // or Render's own probe would report the service down.
          const health = await app.inject({ method: 'GET', url: '/health' });
          expect(health.statusCode).toBe(200);
        } finally {
          await app.close();
          await app.visionService.close();
        }
      });
    }, 60000);

    it('text-only mode skips the barcode stage and still returns OCR text', async () => {
      const port = new URL(imgServer.origin).port;
      const env = { ...BASE_ENV, ALLOWED_URL_PORTS: port };
      await withEnv(env, async () => {
        const config = loadConfig();
        const app = await buildServer({ config, logger: silentLogger() });
        try {
          const res = await app.inject({
            method: 'POST',
            url: '/v1/analyze',
            headers: { 'content-type': 'application/json', 'x-api-key': TEST_API_KEY },
            payload: { image_url: imgServer.url('label-indian.png'), options: { detect_barcode: false } },
          });
          expect(res.statusCode).toBe(200);
          const body = res.json();
          // The stage was skipped on request, so no barcode was searched for and
          // none is reported - not a failure, not a guess.
          expect(body.barcode.detected).toBe(false);
          expect(body.barcode.primary).toBeNull();
          expect(body.diagnostics.barcode_engines_attempted).toEqual([]);
          expect(body.warnings).toContain('barcode_skipped_by_request');
          // The point of the mode: the text is still extracted.
          expect(body.ocr.detected).toBe(true);
          expect(body.ocr.raw_text.length).toBeGreaterThan(0);
          expect(body.ocr.normalized_text.length).toBeGreaterThan(0);
        } finally {
          await app.close();
          await app.visionService.close();
        }
      });
    }, 60000);
  });
});
