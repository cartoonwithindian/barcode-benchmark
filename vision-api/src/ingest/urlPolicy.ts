/**
 * URL policy: syntax validation and hostname/IP vetting before any bytes are
 * fetched. Combines with `downloader.ts` (which re-validates every redirect
 * hop and pins the resolved address at connect time).
 */
import dns from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { AppConfig } from '../config/index.js';
import { AppError, ErrorCode } from '../core/errors.js';
import { classifyIp, isIpLiteral } from './ipPolicy.js';

export interface ValidatedUrl {
  href: string;
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };
const MAX_URL_LENGTH = 2048;

/** Rejects hostnames that are obviously not public services. */
const SUSPICIOUS_HOST_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^localhost$/i, reason: 'localhost hostname' },
  { pattern: /\.local$/i, reason: 'mDNS .local hostname' },
  { pattern: /\.internal$/i, reason: 'internal hostname' },
  { pattern: /\.localdomain$/i, reason: 'localdomain hostname' },
  { pattern: /^metadata\./i, reason: 'cloud metadata hostname' },
  { pattern: /^metadata$/i, reason: 'cloud metadata hostname' },
  { pattern: /^169\.254\./, reason: 'cloud metadata address' },
  { pattern: /\bmetadata\b/i, reason: 'metadata endpoint hostname' },
];

export function parseAndValidateSyntax(rawUrl: string, config: AppConfig): URL {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new AppError(ErrorCode.VALIDATION_ERROR, 'image_url is required and must be a non-empty string.');
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new AppError(ErrorCode.INVALID_URL, 'image_url exceeds the maximum supported length.');
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError(ErrorCode.INVALID_URL, 'image_url is not a valid absolute URL.');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new AppError(ErrorCode.UNSUPPORTED_SCHEME, 'image_url must use http or https.');
  }
  if (url.username || url.password) {
    throw new AppError(ErrorCode.INVALID_URL, 'image_url must not contain credentials.');
  }
  if (!url.hostname) {
    throw new AppError(ErrorCode.INVALID_URL, 'image_url must contain a hostname.');
  }
  // Reject hostnames that smuggle a private target through decimal/octal/hex forms.
  const normalisedHost = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^\d+$/.test(normalisedHost) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(normalisedHost)) {
    // e.g. http://2130706433/ — decimal-encoded 127.0.0.1
    const decoded = Number(normalisedHost);
    if (Number.isFinite(decoded) && decoded > 0) {
      throw new AppError(ErrorCode.BLOCKED_URL, 'image_url host resolves to a blocked address range.');
    }
  }
  if (/^0x[0-9a-f]+$/.test(normalisedHost)) {
    throw new AppError(ErrorCode.BLOCKED_URL, 'image_url host resolves to a blocked address range.');
  }

  for (const { pattern, reason } of SUSPICIOUS_HOST_PATTERNS) {
    if (pattern.test(normalisedHost)) {
      throw new AppError(ErrorCode.BLOCKED_URL, 'image_url host is not permitted.', { details: { reason } });
    }
  }

  const isHttps = url.protocol === 'https:';
  const allowlist = config.security.privateHostAllowlist;
  const exempt = allowlist.includes(normalisedHost);

  if (!isHttps) {
    const httpAllowed = config.security.allowHttp || config.security.httpAllowedHosts.includes(normalisedHost);
    if (!httpAllowed) {
      throw new AppError(ErrorCode.UNSUPPORTED_SCHEME, 'image_url must use https.');
    }
  }

  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  const portAllowed =
    config.security.allowedPorts.includes(port) ||
    (port === 80 && url.protocol === 'http:') ||
    (port === 443 && url.protocol === 'https:');
  if (!portAllowed) {
    throw new AppError(ErrorCode.INVALID_URL, 'image_url port is not allowed.', {
      details: { port },
    });
  }

  if (config.security.allowedImageHosts.length > 0 && !exempt) {
    const hostAllowed = config.security.allowedImageHosts.some(
      (h) => normalisedHost === h || normalisedHost.endsWith(`.${h}`),
    );
    if (!hostAllowed) {
      throw new AppError(ErrorCode.BLOCKED_URL, 'image_url host is not in the configured allowlist.', {
        details: { host: normalisedHost },
      });
    }
  }

  return url;
}

/**
 * Full validation: syntax + DNS resolution + per-address range checks.
 * Throws `AppError` when the target is not publicly routable.
 */
export async function validateImageUrl(rawUrl: string, config: AppConfig): Promise<ValidatedUrl> {
  const url = parseAndValidateSyntax(rawUrl, config);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const exempt = config.security.privateHostAllowlist.includes(hostname);

  if (isIpLiteral(hostname)) {
    if (!exempt) {
      const verdict = classifyIp(hostname);
      if (!verdict.allowed) {
        throw new AppError(ErrorCode.BLOCKED_URL, 'image_url host is not permitted.', {
          details: { reason: verdict.reason },
        });
      }
    }
    return {
      href: url.href,
      protocol: url.protocol as 'http:' | 'https:',
      hostname,
      port: url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol],
      addresses: [{ address: hostname, family: (hostname.includes(':') ? 6 : 4) as 4 | 6 }],
    };
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, 'Could not resolve the image_url hostname.', {
      details: { reason: err instanceof Error ? err.message : String(err) },
      cause: err,
    });
  }
  if (records.length === 0) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, 'image_url hostname did not resolve to any address.');
  }

  const addresses: Array<{ address: string; family: 4 | 6 }> = [];
  for (const record of records) {
    const family = record.family === 6 ? 6 : 4;
    const verdict = classifyIp(record.address);
    if (!verdict.allowed) {
      // A single private answer is enough to reject: mixing public and private
      // answers is a classic DNS-rebinding setup.
      throw new AppError(ErrorCode.BLOCKED_URL, 'image_url host resolves to a blocked address range.', {
        details: { reason: verdict.reason },
      });
    }
    addresses.push({ address: record.address, family });
  }

  return {
    href: url.href,
    protocol: url.protocol as 'http:' | 'https:',
    hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol],
    addresses,
  };
}

/**
 * `lookup` implementation handed to undici's connect options. It re-runs the
 * range check at connection time so a DNS answer that changes between
 * validation and connect (rebinding) is rejected.
 */
export function createPinnedLookup(config: AppConfig, hostname: string) {
  return async (
    host: string,
    options: LookupOptions | number,
    // Mirrors Node's `net.LookupFunction`: on error only `err` is supplied;
    // with `all: true` the second argument is the full address list.
    callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void,
  ): Promise<void> => {
    const wantsAll = typeof options === 'object' && options.all === true;
    try {
      const normalised = host.toLowerCase().replace(/^\[|\]$/g, '');
      if (!config.security.privateHostAllowlist.includes(normalised)) {
        if (isIpLiteral(normalised)) {
          const verdict = classifyIp(normalised);
          if (!verdict.allowed) {
            callback(Object.assign(new Error(`blocked address: ${verdict.reason}`), { code: 'EBLOCKED' }));
            return;
          }
          callback(null, normalised, (normalised.includes(':') ? 6 : 4) as number);
          return;
        }
      }
      const records = await dns.lookup(normalised, { all: true, verbatim: true });
      const filtered = records.filter((r) => {
        if (config.security.privateHostAllowlist.includes(normalised)) return true;
        return classifyIp(r.address).allowed;
      });
      if (filtered.length === 0) {
        callback(Object.assign(new Error('all resolved addresses are blocked'), { code: 'EBLOCKED' }));
        return;
      }
      if (wantsAll) {
        callback(null, filtered as unknown as LookupAddress[]);
        return;
      }
      const first = filtered[0];
      callback(null, first.address, first.family);
    } catch (err) {
      callback(err as NodeJS.ErrnoException);
    }
  };
}

/** Test-friendly helper: the hostname a request will be sent to. */
export function requestHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}