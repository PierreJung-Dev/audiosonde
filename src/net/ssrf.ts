import { isIP } from 'node:net';

/**
 * SSRF address policy (see docs/architecture.md, security model).
 *
 * Every outbound connection — source fetch AND callback POST, including every
 * redirect hop — must resolve to a public unicast address. Private, loopback,
 * link-local, CGN, multicast, documentation and reserved ranges are refused.
 *
 * The policy is applied inside the DNS lookup used to open the socket (see
 * net/request.ts), so the address that is checked is the address that is
 * dialed — a DNS answer can't pass validation and then rebind.
 */

export interface AddressPolicy {
  /** Returns null when the address may be dialed, or a reason when blocked. */
  check(address: string): string | null;
}

interface Ipv4Range {
  readonly base: number;
  readonly maskBits: number;
  readonly reason: string;
}

function ipv4ToInt(parts: readonly number[]): number {
  // >>> 0 keeps the value an unsigned 32-bit int.
  return (((parts[0] ?? 0) << 24) | ((parts[1] ?? 0) << 16) | ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)) >>> 0;
}

function range(a: number, b: number, c: number, d: number, maskBits: number, reason: string): Ipv4Range {
  return { base: ipv4ToInt([a, b, c, d]), maskBits, reason };
}

const BLOCKED_IPV4: readonly Ipv4Range[] = [
  range(0, 0, 0, 0, 8, 'this-network (0.0.0.0/8)'),
  range(10, 0, 0, 0, 8, 'private (10.0.0.0/8)'),
  range(100, 64, 0, 0, 10, 'carrier-grade NAT (100.64.0.0/10)'),
  range(127, 0, 0, 0, 8, 'loopback (127.0.0.0/8)'),
  range(169, 254, 0, 0, 16, 'link-local (169.254.0.0/16)'),
  range(172, 16, 0, 0, 12, 'private (172.16.0.0/12)'),
  range(192, 0, 0, 0, 24, 'IETF protocol assignments (192.0.0.0/24)'),
  range(192, 0, 2, 0, 24, 'documentation (192.0.2.0/24)'),
  range(192, 168, 0, 0, 16, 'private (192.168.0.0/16)'),
  range(198, 18, 0, 0, 15, 'benchmarking (198.18.0.0/15)'),
  range(198, 51, 100, 0, 24, 'documentation (198.51.100.0/24)'),
  range(203, 0, 113, 0, 24, 'documentation (203.0.113.0/24)'),
  range(224, 0, 0, 0, 4, 'multicast (224.0.0.0/4)'),
  range(240, 0, 0, 0, 4, 'reserved (240.0.0.0/4, incl. broadcast)'),
];

function checkIpv4(address: string): string | null {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return 'unparseable IPv4 address';
  }
  const value = ipv4ToInt(parts);
  for (const r of BLOCKED_IPV4) {
    const mask = r.maskBits === 0 ? 0 : (~0 << (32 - r.maskBits)) >>> 0;
    // >>> 0 again: & yields a SIGNED 32-bit int, bases ≥ 0x80000000 are not.
    if (((value & mask) >>> 0) === r.base) return r.reason;
  }
  return null;
}

/** Expand an IPv6 address into 8 16-bit groups. Returns null if unparseable. */
function expandIpv6(address: string): number[] | null {
  // Strip a zone index (fe80::1%eth0) — the address part is what matters.
  const zone = address.indexOf('%');
  let addr = zone === -1 ? address : address.slice(0, zone);

  // Trailing dotted-quad (e.g. ::ffff:127.0.0.1) → two trailing groups.
  let v4Groups: number[] | null = null;
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.includes('.', lastColon)) {
    const v4 = addr.slice(lastColon + 1);
    const parts = v4.split('.').map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return null;
    }
    v4Groups = [((parts[0] ?? 0) << 8) | (parts[1] ?? 0), ((parts[2] ?? 0) << 8) | (parts[3] ?? 0)];
    addr = addr.slice(0, lastColon + 1); // keep the colon so '::a.b.c.d' parses
  }

  const targetGroups = 8 - (v4Groups?.length ?? 0);
  const doubleColon = addr.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon !== -1) {
    head = addr.slice(0, doubleColon).split(':').filter((s) => s.length > 0);
    tail = addr.slice(doubleColon + 2).split(':').filter((s) => s.length > 0);
  } else {
    head = addr.split(':').filter((s) => s.length > 0);
    tail = [];
  }
  const fillers = targetGroups - head.length - tail.length;
  if (doubleColon === -1 ? head.length !== targetGroups : fillers < 0) return null;

  const groupStrings = doubleColon === -1 ? head : [...head, ...Array<string>(fillers).fill('0'), ...tail];
  const groups: number[] = [];
  for (const g of groupStrings) {
    const value = parseInt(g, 16);
    if (!/^[0-9a-fA-F]{1,4}$/.test(g) || Number.isNaN(value)) return null;
    groups.push(value);
  }
  if (v4Groups !== null) groups.push(...v4Groups);
  return groups.length === 8 ? groups : null;
}

function checkIpv6(address: string): string | null {
  const g = expandIpv6(address);
  if (g === null) return 'unparseable IPv6 address';
  const g0 = g[0] ?? 0;
  const g1 = g[1] ?? 0;
  const g5 = g[5] ?? 0;
  const g6 = g[6] ?? 0;
  const g7 = g[7] ?? 0;

  const isZero = (from: number, to: number): boolean => g.slice(from, to + 1).every((x) => x === 0);

  // ::ffff:a.b.c.d (IPv4-mapped) and 64:ff9b::/96 (NAT64) → check embedded v4.
  const embeddedV4 = (): string | null => {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return checkIpv4(v4);
  };
  if (isZero(0, 4) && g5 === 0xffff) {
    return embeddedV4() ?? null;
  }
  if (g0 === 0x0064 && g1 === 0xff9b && isZero(2, 5)) {
    return embeddedV4() ?? null;
  }

  if (isZero(0, 7)) return 'unspecified (::)';
  if (isZero(0, 6) && g7 === 1) return 'loopback (::1)';
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
  if ((g0 & 0xfe00) === 0xfc00) return 'unique-local (fc00::/7)';
  if ((g0 & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  if (g0 === 0x2001 && g1 === 0x0db8) return 'documentation (2001:db8::/32)';
  return null;
}

/** The production policy: public unicast addresses only. */
export const publicAddressPolicy: AddressPolicy = {
  check(address: string): string | null {
    const family = isIP(address);
    if (family === 4) return checkIpv4(address);
    if (family === 6) return checkIpv6(address);
    return 'not an IP address';
  },
};

/** Thrown when a connection target is refused by the address policy. */
export class SsrfBlockedError extends Error {
  constructor(
    readonly host: string,
    readonly address: string,
    readonly reason: string,
  ) {
    super(`refusing to connect to ${host} (${address}): ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}
