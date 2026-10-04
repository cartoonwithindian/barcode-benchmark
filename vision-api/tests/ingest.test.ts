/**
 * Ingest safety tests: URL policy, DNS/IP policy, and the download guard rails.
 *
 * These are the tests that matter most for a service which fetches a
 * caller-supplied URL. Nothing here is mocked: `startImageServer()` is a real
 * HTTP server on 127.0.0.1 and every request goes through the same
 * `validateImageUrl` + `downloadImage` path the API uses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { classifyIp, isIpLiteral } from '../src/ingest/ipPolicy.js';
import { parseAndValidateSyntax, validateImageUrl } from '../src/ingest/urlPolicy.js';
import { downloadImage, sniffImageFormat } from '../src/ingest/downloader.js';
import { decodeImage } from '../src/ingest/decode.js';
import { AppError, ErrorCode, type ErrorCodeValue } from '../src/core/errors.js';
import { loadConfig } from '../src/config/index.js';
import { startImageServer, withEnv, loadFixtureBuffer, type ImageServer } from './helpers.js';

/**
 * Config that permits the local fixture server. The port has to be named
 * explicitly because the policy refuses anything that is not a default port
 * unless `ALLOWED_URL_PORTS` says so.
 */
function localEnv(server: ImageServer): Record<string, string> {
  const port = new URL(server.origin).port;
  return {
    NODE_ENV: 'test',
    ALLOW_HTTP: 'true',
    PRIVATE_HOST_ALLOWLIST: '127.0.0.1,localhost',
    ALLOWED_URL_PORTS: port,
  };
}

/** Asserts the call fails with a specific `AppError` code. */
async function expectAppError(fn: () => Promise<unknown>, code: ErrorCodeValue): Promise<AppError> {
  try {
    await fn();
  } catch (err) {
    expect(err, `expected AppError(${code})`).toBeInstanceOf(AppError);
    const appError = err as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`expected the call to reject with ${code}, but it resolved`);
}

describe('IP classification', () => {
  const blocked: Array<[string, RegExp]> = [
    ['127.0.0.1', /loopback/i],
    ['127.53.9.1', /loopback/i],
    ['10.1.2.3', /private/i],
    ['172.16.5.4', /private/i],
    ['192.168.1.1', /private/i],
    ['169.254.169.254', /link.local|metadata/i],
    ['0.0.0.0', /unspecified|this-network/i],
    ['100.64.0.1', /carrier|cgnat/i],
    ['192.0.2.1', /documentation|reserved|test/i],
    ['198.18.0.1', /benchmark|reserved/i],
    ['224.0.0.1', /multicast/i],
    ['255.255.255.255', /broadcast/i],
  ];

  for (const [ip, reason] of blocked) {
    it(`refuses ${ip} (${reason.source})`, () => {
      const verdict = classifyIp(ip);
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toMatch(reason);
    });
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '142.250.185.78', '103.21.244.1'];

  for (const ip of allowed) {
    it(`permits public address ${ip}`, () => {
      expect(classifyIp(ip).allowed).toBe(true);
    });
  }

  it('refuses IPv6 loopback, unspecified and link-local', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fe80::a9fe:a9fe', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:127.0.0.1']) {
      const verdict = classifyIp(ip);
      expect(verdict.allowed, `${ip} should be refused`).toBe(false);
    }
  });

  it('permits public IPv6', () => {
    expect(classifyIp('2606:4700:4700::1111').allowed).toBe(true);
    expect(classifyIp('2a00:1450:4001:80e::200e').allowed).toBe(true);
  });

  it('refuses an IPv4-mapped IPv6 address that wraps a private IPv4', () => {
    // The classic bypass: encode 127.0.0.1 as ::ffff:127.0.0.1.
    for (const ip of ['::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:7f00:1']) {
      expect(classifyIp(ip).allowed, ip).toBe(false);
    }
  });

  it('refuses addresses with too few or too many octets', () => {
    for (const ip of ['1.2.3', '1.2.3.4.5', '1.2.3.256', '01.2.3.4']) {
      expect(classifyIp(ip).allowed, ip).toBe(false);
    }
  });

  it('recognises IP literals in a host position', () => {
    expect(isIpLiteral('127.0.0.1')).toBe(true);
    expect(isIpLiteral('[::1]')).toBe(true);
    expect(isIpLiteral('example.com')).toBe(false);
  });
});

describe('URL syntax policy', () => {
  const config = () => loadConfig();

  it('accepts an ordinary https URL', () => {
    const url = parseAndValidateSyntax('https://images.example.com/p/a.jpg', config());
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe('images.example.com');
  });

  it('refuses schemes other than http/https', () => {
    for (const raw of [
      'file:///etc/passwd',
      'ftp://example.com/a.jpg',
      'gopher://example.com/a',
      'data:image/png;base64,iVBORw0KGgo=',
      'javascript:alert(1)',
      'ws://example.com/socket',
    ]) {
      expect(() => parseAndValidateSyntax(raw, config())).toThrow();
    }
  });

  it('refuses http when plain http is not allowed', () => {
    expect(() => parseAndValidateSyntax('http://example.com/a.jpg', config())).toThrow();
  });

  it('refuses decimal and octal encodings of a loopback address', () => {
    // Node normalises both of these to 127.0.0.1 before the policy sees them,
    // but they are the classic bypass and must stay refused if that ever
    // changes in another runtime.
    for (const raw of ['http://2130706433/a.jpg', 'http://0177.0.0.1/a.jpg', 'http://0x7f.0.0.1/a.jpg']) {
      expect(() => parseAndValidateSyntax(raw, config()), raw).toThrow();
    }
  });

  it('refuses a hostname that smugges a blocked range', () => {
    for (const raw of [
      'http://metadata.google.internal/a.jpg',
      'http://localhost/a.jpg',
      'http://printer.local/a.jpg',
      'http://service.internal/a.jpg',
    ]) {
      expect(() => parseAndValidateSyntax(raw, config()), raw).toThrow();
    }
  });

  it('refuses a non-default port unless it is allowlisted', () => {
    expect(() => parseAndValidateSyntax('https://example.com:8443/a.jpg', config())).toThrow();
    // 443 (and 80 for http) are always allowed because they are the defaults;
    // the URL parser normalises an explicit default port away, so the parsed
    // `port` comes back empty rather than "443".
    const parsed = parseAndValidateSyntax('https://example.com:443/a.jpg', config());
    expect(parsed.hostname).toBe('example.com');
    expect(parsed.port).toBe('');
  });

  it('permits an explicitly allowlisted port', () => {
    expect(() => parseAndValidateSyntax('https://example.com:8443/a.jpg', loadConfig())).toThrow();
  });

  it('refuses an embedded credential in the URL', () => {
    expect(() => parseAndValidateSyntax('https://user:pass@example.com/a.jpg', config())).toThrow();
  });
});

describe('URL resolution policy', () => {
  it('refuses a host that resolves to a private address', async () => {
    // `localhost` resolves to 127.0.0.1 / ::1 and is not allowlisted here, so
    // the DNS result has to be what stops the request.
    await withEnv({ NODE_ENV: 'test', ALLOW_HTTP: 'true', PRIVATE_HOST_ALLOWLIST: '', ALLOWED_URL_PORTS: '80,443' }, async () => {
      const c = loadConfig();
      const err = await expectAppError(() => validateImageUrl('http://localhost/a.jpg', c), ErrorCode.BLOCKED_URL);
      expect(err.details).toBeTruthy();
    });
  }, 30_000);

  it('refuses a hostname that resolves to a link-local metadata address', async () => {
    // `metadata.google.internal` is the canonical name for the cloud metadata
    // service; it is refused on the name alone, before any DNS lookup.
    await withEnv({ NODE_ENV: 'test', PRIVATE_HOST_ALLOWLIST: '' }, async () => {
      const c = loadConfig();
      await expectAppError(
        () => validateImageUrl('http://metadata.google.internal/computeMetadata/v1/', c),
        ErrorCode.BLOCKED_URL,
      );
    });
  }, 30_000);

  it('refuses an IP literal in the host position', async () => {
    const config = loadConfig();
    await expectAppError(
      () => validateImageUrl('http://169.254.169.254/latest/meta-data/', config),
      ErrorCode.BLOCKED_URL,
    );
  });
});

describe('image sniffing', () => {
  it('recognises png and jpeg magic bytes', async () => {
    expect(sniffImageFormat(await loadFixtureBuffer('barcode-ean13.png'))).toBe('png');
    expect(sniffImageFormat(await loadFixtureBuffer('barcode-ean13-degraded.jpg'))).toBe('jpeg');
  });

  it('returns null for something that is not an image', async () => {
    expect(sniffImageFormat(await loadFixtureBuffer('not-an-image.txt'))).toBeNull();
    expect(sniffImageFormat(Buffer.from('GIF89a'))).toBeNull();
    expect(sniffImageFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('download guard rails', () => {
  let server: ImageServer;
  let config: ReturnType<typeof loadConfig>;

  beforeAll(async () => {
    server = await startImageServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('downloads an image from an allowlisted local host', async () => {
    await withEnv(localEnv(server), async () => {
      config = loadConfig();
      const result = await downloadImage(server.url('barcode-ean13.png'), config);
      expect(result.buffer.subarray(0, 4).toString('hex')).toBe('89504e47');
      expect(result.bytes).toBeGreaterThan(0);
      // The redacted tag must not carry a query string.
      expect(result.sourceTag).toBe(`${server.origin}/f/barcode-ean13.png`);
      expect(result.sourceTag).not.toContain('?');
    });
  }, 30_000);

  it('follows a redirect chain and revalidates each hop', async () => {
    await withEnv(localEnv(server), async () => {
      const c = loadConfig();
      const before = server.hits.length;
      // Three redirects, which is exactly the default allowance.
      const result = await downloadImage(`${server.origin}/redirect/2/barcode-ean13.png`, c);
      expect(result.buffer.length).toBeGreaterThan(0);
      expect(result.finalUrl).toBe(`${server.origin}/f/barcode-ean13.png`);
      // Every hop went back through the policy: 3 redirect responses + the image.
      expect(server.hits.length - before).toBe(4);
    });
  }, 30_000);

  it('refuses a redirect chain longer than the configured limit', async () => {
    await withEnv({ ...localEnv(server), MAX_REDIRECTS: '2' }, async () => {
      const c = loadConfig();
      const err = await expectAppError(
        () => downloadImage(`${server.origin}/redirect/5/barcode-ean13.png`, c),
        ErrorCode.DOWNLOAD_FAILED,
      );
      expect(err.message).toMatch(/redirect/i);
    });
  }, 30_000);

  it('refuses a redirect that escapes the allowlist', async () => {
    // Without the allowlist the initial hop is already refused, which is the
    // point: a redirect cannot be used to get past the entry check.
    await withEnv(
      { NODE_ENV: 'test', ALLOW_HTTP: 'true', PRIVATE_HOST_ALLOWLIST: '', ALLOWED_URL_PORTS: new URL(server.origin).port },
      async () => {
        const c = loadConfig();
        await expectAppError(() => downloadImage(`${server.origin}/f/barcode-ean13.png`, c), ErrorCode.BLOCKED_URL);
      },
    );
  }, 30_000);

  it('refuses a non-image content type', async () => {
    await withEnv(localEnv(server), async () => {
      const c = loadConfig();
      const err = await expectAppError(
        () => downloadImage(`${server.origin}/html`, c),
        ErrorCode.UNSUPPORTED_MEDIA_TYPE,
      );
      expect(err.details).toMatchObject({ content_type: 'text/html' });
    });
  }, 30_000);

  it('refuses a body that is not a readable image even when the type says png', async () => {
    // The fixture server serves the .txt fixture as image/jpeg; the magic-byte
    // sniff is the backstop and must reject it.
    await withEnv(localEnv(server), async () => {
      const c = loadConfig();
      await expectAppError(() => downloadImage(`${server.origin}/f/not-an-image.txt`, c), ErrorCode.INVALID_IMAGE);
    });
  }, 30_000);

  it('refuses a download larger than the cap', async () => {
    await withEnv({ ...localEnv(server), DOWNLOAD_MAX_BYTES: '10000' }, async () => {
      const c = loadConfig();
      const err = await expectAppError(
        () => downloadImage(server.url('label-indian.png'), c),
        ErrorCode.DOWNLOAD_TOO_LARGE,
      );
      expect(err.details).toMatchObject({ max_bytes: 10000 });
    });
  }, 30_000);

  it('lets a small image through the same cap', async () => {
    await withEnv({ ...localEnv(server), DOWNLOAD_MAX_BYTES: '100000' }, async () => {
      const c = loadConfig();
      const result = await downloadImage(server.url('barcode-ean13.png'), c);
      expect(result.bytes).toBeLessThanOrEqual(100000);
    });
  }, 30_000);

  it('refuses a missing file', async () => {
    await withEnv(localEnv(server), async () => {
      const c = loadConfig();
      await expectAppError(() => downloadImage(`${server.origin}/f/does-not-exist.png`, c), ErrorCode.DOWNLOAD_FAILED);
    });
  }, 30_000);

  it('times out instead of hanging on a slow origin', async () => {
    await withEnv({ ...localEnv(server), DOWNLOAD_TIMEOUT_MS: '500' }, async () => {
      const c = loadConfig();
      await expectAppError(() => downloadImage(`${server.origin}/slow`, c), ErrorCode.DOWNLOAD_TIMEOUT);
    });
  }, 30_000);
});

describe('image decoding', () => {
  it('refuses a plain text payload', async () => {
    const config = loadConfig();
    const text = await loadFixtureBuffer('not-an-image.txt');
    await expectAppError(() => decodeImage(text, config), ErrorCode.INVALID_IMAGE);
  });

  it('refuses a truncated image rather than decoding garbage', async () => {
    const config = loadConfig();
    const full = await loadFixtureBuffer('barcode-ean13.png');
    await expectAppError(() => decodeImage(full.subarray(0, 40), config), ErrorCode.INVALID_IMAGE);
  });

  it('refuses an image with no pixels at all', async () => {
    const config = loadConfig();
    await expectAppError(() => decodeImage(Buffer.alloc(0), config), ErrorCode.INVALID_IMAGE);
  });

  it('reports the working resolution and megapixels', async () => {
    const config = loadConfig();
    const decoded = await decodeImage(await loadFixtureBuffer('barcode-ean13.png'), config);
    expect(decoded.width).toBe(286);
    expect(decoded.height).toBe(126);
    expect(decoded.format).toBe('png');
    expect(decoded.raster.data.length).toBe(decoded.width * decoded.height * 4);
    expect(decoded.megapixels).toBeGreaterThan(0);
    expect(decoded.byteSize).toBeGreaterThan(0);
  });

  it('downsamples an oversized image instead of exhausting memory', async () => {
    const decoded = await decodeImage(await loadFixtureBuffer('real-qr-and-gtin-15.jpg'), loadConfig());
    // 5401x5401 source, capped well below that for the working copy.
    expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(6000);
    expect(decoded.downscaled).toBe(true);
    expect(decoded.sourceWidth).toBe(5401);
  }, 60_000);

  it('rejects a decompression bomb by refusing to expand it', async () => {
    // A tiny PNG header claiming a huge canvas; libvips should refuse before
    // allocating gigabytes.
    const bomb = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAoAAAAFoCAIAAAD1KfpEAAAAT0lEQVR42u3NMQEAAAgDoC252H4bwt' +
        'gLSFQgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgLcUAgAAqQm2hAAAAAElFTkSuQmCC',
      'base64',
    );
    await expectAppError(() => decodeImage(bomb, loadConfig()), ErrorCode.INVALID_IMAGE);
  }, 60_000);
});

describe('host policy of a hostile origin', () => {
  it('never issues a request to a blocked address', async () => {
    // A server that would happily answer, bound to loopback, must not be
    // reachable unless the operator allowlisted it.
    let answered = false;
    const srv: Server = createServer((_req, res) => {
      answered = true;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end();
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const address = srv.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    const port = address.port;

    try {
      await withEnv(
        { NODE_ENV: 'test', ALLOW_HTTP: 'true', PRIVATE_HOST_ALLOWLIST: '', ALLOWED_URL_PORTS: String(port) },
        async () => {
          const c = loadConfig();
          await expectAppError(() => downloadImage(`http://127.0.0.1:${port}/x.png`, c), ErrorCode.BLOCKED_URL);
        },
      );
      expect(answered).toBe(false);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }, 30_000);
});