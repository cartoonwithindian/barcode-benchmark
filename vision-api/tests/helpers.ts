/**
 * Shared test helpers: environment isolation, fixture loading, and a local
 * image server.
 *
 * The image server exists so the full HTTP path (`POST /v1/analyze` with an
 * `image_url`) is exercised for real, including the SSRF policy. Serving from
 * `127.0.0.1` is only possible because the test environment explicitly sets
 * `PRIVATE_HOST_ALLOWLIST`, which is the same opt-in an operator would use for
 * internal object storage — so the allowlist path itself is under test.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { Raster } from '../src/imaging/raster.js';
import { decodeImage } from '../src/ingest/decode.js';
import { loadConfig, type AppConfig } from '../src/config/index.js';
import { build } from '../src/core/logger.js';
import type { VisionServer } from '../src/types/fastify.js';
import { buildServer } from '../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = path.join(here, 'fixtures');

export function fixturePath(file: string): string {
  return path.join(FIXTURES_DIR, file);
}

/** Ground truth recorded by `scripts/generate-fixtures.ts`. */
export interface Manifest {
  generated_by: string;
  fixtures: Array<{
    file: string;
    kind: 'generated' | 'upstream-photo';
    expect?: Record<string, unknown>;
    note?: string;
  }>;
}

let manifestCache: Manifest | null = null;
export async function loadManifest(): Promise<Manifest> {
  if (!manifestCache) {
    manifestCache = JSON.parse(await readFile(fixturePath('manifest.json'), 'utf8')) as Manifest;
  }
  return manifestCache;
}

export async function expectationFor(file: string): Promise<Record<string, unknown>> {
  const manifest = await loadManifest();
  const entry = manifest.fixtures.find((f) => f.file === file);
  if (!entry) throw new Error(`fixture ${file} is not in manifest.json`);
  return entry.expect ?? {};
}

/** Loads a fixture straight into a `Raster`, bypassing HTTP and the SSRF policy. */
export async function loadRaster(file: string): Promise<Raster> {
  const config = loadConfig();
  const buffer = await readFile(fixturePath(file));
  const decoded = await decodeImage(buffer, config);
  return decoded.raster;
}

export async function loadFixtureBuffer(file: string): Promise<Buffer> {
  return readFile(fixturePath(file));
}

export async function fixtureDimensions(file: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(await loadFixtureBuffer(file)).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

/** A silent logger so test output only shows assertion failures. */
export function silentLogger() {
  return build({ level: 'silent', pretty: false, isProduction: false });
}

/**
 * Sets an env var for the duration of `fn` and restores the previous value.
 * `loadConfig()` re-reads `process.env` on every call, so this is enough to
 * give a test its own configuration.
 */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export interface ImageServer {
  url(file: string): string;
  origin: string;
  /** Requests received, for asserting redirect behaviour. */
  hits: string[];
  close(): Promise<void>;
}

/**
 * Serves the fixtures directory. Routes:
 *   /f/<name>            the fixture, correct content type
 *   /redirect/<n>/<name> n redirects before serving /f/<name>
 *   /html                an HTML page (must be rejected as a non-image)
 *   /slow                never responds (used for timeout tests)
 */
export async function startImageServer(): Promise<ImageServer> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    hits.push(url.pathname);

    if (url.pathname === '/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>not an image</body></html>');
      return;
    }

    if (url.pathname === '/slow') {
      // Never responds; the client's AbortSignal must fire.
      return;
    }

    const redirect = /^\/redirect\/(\d+)\/(.+)$/.exec(url.pathname);
    if (redirect) {
      const hops = Number(redirect[1]);
      const target = redirect[2]!;
      if (hops > 0) {
        res.writeHead(302, { location: `/redirect/${hops - 1}/${target}` });
        res.end();
      } else {
        res.writeHead(302, { location: `/f/${target}` });
        res.end();
      }
      return;
    }

    const file = /^\/f\/(.+)$/.exec(url.pathname)?.[1];
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }

    void (async () => {
      try {
        const buffer = await readFile(fixturePath(decodeURIComponent(file)));
        const type = buffer.subarray(0, 4).toString('hex') === '89504e47' ? 'image/png' : 'image/jpeg';
        res.writeHead(200, { 'content-type': type, 'content-length': String(buffer.length) });
        res.end(buffer);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('no such fixture');
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('image server did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    url: (file: string) => `${origin}/f/${file}`,
    hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface TestServer {
  app: VisionServer;
  config: AppConfig;
  close(): Promise<void>;
}

/** Boots the real Fastify app against an explicit config, for `app.inject()`. */
export async function startTestServer(config?: AppConfig): Promise<TestServer> {
  const resolved = config ?? loadConfig();
  const app = await buildServer({ config: resolved, logger: silentLogger() });
  return {
    app,
    config: resolved,
    close: async () => {
      await app.close();
      await app.visionService.close();
    },
  };
}

/**
 * Environment for the integration tests: authentication on, localhost
 * allowlisted for the fixture server, and the fast tessdata model so the suite
 * does not download or unpack the 10.8 MB accuracy model.
 */
export const TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  API_KEYS: 'test-key-alpha,test-key-beta',
  ALLOW_HTTP: 'true',
  PRIVATE_HOST_ALLOWLIST: '127.0.0.1,localhost',
  ALLOWED_URL_PORTS: '',
  OCR_LANG_PATH: 'assets/tessdata-fast',
  OCR_WORKER_LIMIT: '1',
  LOG_LEVEL: 'silent',
  CACHE_ENABLED: 'false',
};

export const TEST_API_KEY = 'test-key-alpha';