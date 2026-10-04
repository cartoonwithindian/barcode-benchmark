/**
 * IP address policy — the core of the SSRF defence.
 *
 * A URL that looks public can still resolve to a loopback, link-local,
 * private or otherwise reserved address. Every resolved address must pass this
 * check before a connection is opened, and the check is re-run inside the
 * socket `lookup` hook to close the DNS-rebinding window.
 */

export type IpVerdict = { allowed: true; family: 4 | 6 } | { allowed: false; reason: string };

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    // Reject leading zeros outright. `0177.0.0.1` is parsed as octal by some
    // resolvers and as 177.0.0.1 by others; refusing the whole form removes
    // the ambiguity instead of guessing which one the socket layer would use.
    if (part.length > 1 && part.startsWith('0')) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

const IPV4_BLOCKS: Array<{ cidr: string; reason: string }> = [
  { cidr: '0.0.0.0/8', reason: 'unspecified address' },
  { cidr: '10.0.0.0/8', reason: 'private network (RFC1918)' },
  { cidr: '100.64.0.0/10', reason: 'carrier-grade NAT (RFC6598)' },
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '169.254.0.0/16', reason: 'link-local / cloud metadata (169.254.169.254)' },
  { cidr: '172.16.0.0/12', reason: 'private network (RFC1918)' },
  { cidr: '192.0.0.0/24', reason: 'IETF protocol assignments' },
  { cidr: '192.0.2.0/24', reason: 'documentation range (TEST-NET-1)' },
  { cidr: '192.168.0.0/16', reason: 'private network (RFC1918)' },
  { cidr: '198.18.0.0/15', reason: 'benchmarking range' },
  { cidr: '198.51.100.0/24', reason: 'documentation range (TEST-NET-2)' },
  { cidr: '203.0.113.0/24', reason: 'documentation range (TEST-NET-3)' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
  { cidr: '240.0.0.0/4', reason: 'reserved (includes 255.255.255.255 broadcast)' },
];

const IPV4_TABLE = IPV4_BLOCKS.map((b) => ({ ...b, base: ipv4BlockBase(b.cidr), mask: ipv4Mask(b.cidr) }));

function ipv4BlockBase(cidr: string): number {
  const [ip] = cidr.split('/');
  return ipv4ToInt(ip) ?? 0;
}

function ipv4Mask(cidr: string): number {
  const bits = Number(cidr.split('/')[1] ?? 32);
  return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

export function classifyIPv4(ip: string): IpVerdict {
  const value = ipv4ToInt(ip);
  if (value === null) return { allowed: false, reason: 'unparseable IPv4 address' };
  for (const block of IPV4_TABLE) {
    if ((value & block.mask) >>> 0 === block.base) {
      return { allowed: false, reason: `blocked address range ${block.cidr} (${block.reason})` };
    }
  }
  return { allowed: true, family: 4 };
}

function expandIPv6(ip: string): number[] | null {
  let address = ip.trim().toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);

  // An embedded IPv4 tail (::ffff:1.2.3.4) has to become two hex words *in
  // place*. Appending them after the `::` expansion instead would shift every
  // group left by two, which makes a mapped loopback look public.
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail);
    if (v4 === null) return null;
    const high = (v4 >>> 16) & 0xffff;
    const low = v4 & 0xffff;
    address = `${address.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }

  const [headText, tailPart] = address.split('::');
  if (tailPart !== undefined && address.indexOf('::') !== address.lastIndexOf('::')) return null;

  const parse = (text: string): number[] | null => {
    if (text === '') return [];
    const words = text.split(':');
    const out: number[] = [];
    for (const w of words) {
      if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
      out.push(parseInt(w, 16));
    }
    return out;
  };

  const head = parse(headText);
  const rest = tailPart !== undefined ? parse(tailPart) : [];
  if (head === null || rest === null) return null;

  const known = head.length + rest.length;
  let words: number[];
  if (tailPart !== undefined) {
    const fill = 8 - known;
    if (fill < 0) return null;
    words = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    words = [...head];
  }
  if (words.length !== 8) return null;
  return words;
}

/**
 * True when the address is an IPv4-mapped (`::ffff:a.b.c.d`) or
 * IPv4-compatible (`::a.b.c.d`) form, in which case the last two 16-bit words
 * are really an IPv4 address and must be judged as one.
 */
export function embeddedIPv4(ip: string): string | null {
  const words = expandIPv6(ip);
  if (!words) return null;
  const isMapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  const isCompat = words.slice(0, 6).every((w) => w === 0) && (words[6] !== 0 || words[7] > 1);
  if (!isMapped && !isCompat) return null;
  const value = (((words[6] << 16) >>> 0) + words[7]) >>> 0;
  return `${value >>> 24}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`;
}

export function classifyIPv6(ip: string): IpVerdict {
  const words = expandIPv6(ip);
  if (!words) return { allowed: false, reason: 'unparseable IPv6 address' };

  const zeroRange = (from: number, to: number) => words.slice(from, to).every((w) => w === 0);

  if (words.every((w) => w === 0)) return { allowed: false, reason: 'unspecified address' };
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return { allowed: false, reason: 'loopback' };
  // Handled by `classifyIp`, which judges the embedded IPv4 address.
  if (embeddedIPv4(ip) !== null) {
    return { allowed: false, reason: 'IPv4-mapped address (judged as IPv4)' };
  }
  if (words[0] === 0xfe80) return { allowed: false, reason: 'link-local' };
  if ((words[0] & 0xfe00) === 0xfc00) return { allowed: false, reason: 'unique local address (fc00::/7)' };
  // IPv6 multicast is the whole of ff00::/8, not just ffc0::/6.
  if ((words[0] & 0xff00) === 0xff00) return { allowed: false, reason: 'multicast' };
  if (words[0] === 0x2001 && words[1] === 0x0db8) return { allowed: false, reason: 'documentation range' };
  if (words[0] === 0x0100 && zeroRange(1, 5)) return { allowed: false, reason: 'discard prefix (100::/64)' };
  if (words[0] === 0x2001 && (words[1] & 0xfffd) === 0) return { allowed: false, reason: 'Teredo tunnel address' };
  if ((words[0] & 0xfe00) === 0x0200 && zeroRange(1, 2)) return { allowed: false, reason: '3gpp6 (2002::/16)' };
  return { allowed: true, family: 6 };
}

export function classifyIp(ip: string): IpVerdict {
  if (ip.includes(':')) {
    const embedded = embeddedIPv4(ip);
    // A mapped address is only as safe as the IPv4 address inside it, so it
    // inherits the IPv4 verdict rather than a blanket allow.
    if (embedded !== null) return classifyIPv4(embedded);
    return classifyIPv6(ip);
  }
  return classifyIPv4(ip);
}

export function isAllowedIp(ip: string): boolean {
  return classifyIp(ip).allowed;
}

/** True when the host is a bare IP literal. */
export function isIpLiteral(host: string): boolean {
  return ipv4ToInt(host) !== null || expandIPv6(host) !== null;
}