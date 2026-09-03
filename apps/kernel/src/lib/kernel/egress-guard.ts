/**
 * SSRF egress guard for owner-supplied inference endpoints (#1957).
 *
 * The `local` inference connector is the first place the kernel ever fetches
 * a URL the OWNER typed in, rather than a hardcoded, trusted provider host.
 * That is a categorically different trust boundary from every other
 * `BRAIN_CONNECTORS` entry, and it is load-bearing: an unguarded fetch would
 * let any DID that can seal a `local` connector card point the kernel's own
 * network position at loopback, link-local, or cloud-metadata addresses.
 *
 * This module answers exactly one question — "is this URL safe for the
 * kernel to connect to?" — via {@link checkEgressTarget}. It does the actual
 * DNS resolution (resolve-then-connect) so the caller can pin the connection
 * to the address that was actually validated, rather than re-resolving at
 * connect time and risking a DNS-rebinding race between check and connect.
 * See `egress-fetch.ts` for the fetch that consumes this.
 *
 * ## Threat model
 * - Scheme confusion (`file:`, `gopher:`, etc.) — rejected outright; only
 *   `http:`/`https:` may be forwarded to.
 * - Numeric/obfuscated IPv4 hosts (`http://2130706433/`, `http://0177.0.0.1/`)
 *   — closed by `new URL()` itself: the WHATWG host parser normalises these
 *   to dotted-decimal before this module ever sees a hostname.
 * - IPv4-mapped IPv6 (`::ffff:127.0.0.1`) — unwrapped and reclassified as the
 *   underlying IPv4 address before any range check runs, so it cannot slip
 *   past the IPv4 loopback/link-local checks under an IPv6 disguise.
 * - Loopback, unspecified ("this host"), link-local (including the
 *   `169.254.169.254` cloud metadata address every major cloud shares),
 *   IPv6 unique-local (`fd00::/8`, which is where AWS's IPv6 metadata
 *   endpoint `fd00:ec2::254` lives), multicast, and IANA-reserved ranges are
 *   all denied.
 * - RFC1918 private space (`10/8`, `172.16/12`, `192.168/16`) is the one
 *   range every other egress guard in existence would deny and this one
 *   explicitly allows — that is the entire point of the connector (Ollama
 *   on imajin-ml, vLLM/Nemotron on PGX both live on the LAN). The allowance
 *   is declared once, by name, right here — not an accidental gap in a
 *   deny-list someone forgot to close.
 * - DNS rebinding (validate a hostname, then have its DNS record change
 *   before the connection is made) — this module resolves once and hands
 *   back the concrete address it validated; the caller (`egress-fetch.ts`,
 *   and `local`'s "host pin after first save" contract) is responsible for
 *   connecting to THAT address rather than re-resolving the hostname later.
 */
import { promises as dns } from 'node:dns';

/** Address family, matching Node's own `net`/`dns` convention. */
export type AddressFamily = 4 | 6;

/** Why a target was denied. Machine-readable, safe to log and to test against. */
export type EgressDenialReason =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'invalid_host'
  | 'dns_resolution_failed'
  | 'loopback'
  | 'unspecified'
  | 'link_local'
  | 'unique_local_metadata'
  | 'multicast'
  | 'reserved';

export interface EgressAllowResult {
  ok: true;
  /** The validated URL (unchanged from the input, beyond WHATWG normalisation). */
  url: URL;
  /** The address `egress-fetch.ts` should connect to and pin. */
  ip: string;
  family: AddressFamily;
}

export interface EgressDenyResult {
  ok: false;
  reason: EgressDenialReason;
  /** Human-readable, safe to return to the owner who configured the URL. */
  message: string;
}

export type EgressCheckResult = EgressAllowResult | EgressDenyResult;

/** Schemes this guard will ever forward to. Everything else is refused outright. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

function deny(reason: EgressDenialReason, message: string): EgressDenyResult {
  return { ok: false, reason, message };
}

// ── IPv4 range checks ────────────────────────────────────────────────────────

function ipv4Octets(ip: string): [number, number, number, number] {
  const parts = ip.split('.').map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

/**
 * RFC1918 private space — the allowance this whole connector exists for.
 * Exported (via `__internal`) purely for direct unit testing of the
 * allow-list, mirroring how `classifyAddress` is tested for the deny-list.
 */
function isRfc1918(ip: string): boolean {
  const [a, b] = ipv4Octets(ip);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function classifyIpv4(ip: string): EgressDenialReason | undefined {
  const [a, b] = ipv4Octets(ip);
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return 'link_local'; // covers 169.254.169.254 (cloud metadata)
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240 || ip === '255.255.255.255') return 'reserved';
  return undefined;
}

// ── IPv6 range checks ────────────────────────────────────────────────────────

/** `::ffff:a.b.c.d` → `a.b.c.d`, or `undefined` when `ip` is not IPv4-mapped. */
function unwrapIpv4MappedIpv6(ip: string): string | undefined {
  const lower = ip.toLowerCase();
  const match = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  return match?.[1];
}

/** Minimal `::`-aware IPv6 expansion into 8 numeric hextets. */
function expandIpv6(ip: string): number[] {
  if (!ip.includes('::')) {
    return ip.split(':').map((h) => parseInt(h, 16) || 0);
  }
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean).map((h) => parseInt(h, 16)) : [];
  const missing = 8 - headParts.length - tailParts.length;
  return [...headParts, ...(Array(Math.max(missing, 0)).fill(0) as number[]), ...tailParts];
}

function classifyIpv6(ip: string): EgressDenialReason | undefined {
  const lower = ip.toLowerCase();
  if (lower === '::1') return 'loopback';
  if (lower === '::') return 'unspecified';

  // Expand to 8 hextets for the leading-bits comparisons below. Node's `dns`
  // module returns canonical (already-compressed) forms, so a light manual
  // expansion is all that's needed here — a full IPv6 parser is overkill for
  // range classification alone.
  const segments = expandIpv6(lower);
  const first16 = segments[0] ?? 0;
  const second16 = segments[1] ?? 0;

  if ((first16 & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((first16 & 0xff00) === 0xfd00) return 'unique_local_metadata'; // fd00::/8
  if ((first16 & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  // 100::/64 ("discard-only"), documented in RFC6666, is IANA-reserved.
  if (first16 === 0x0100 && second16 === 0) return 'reserved';
  return undefined;
}

/** Classify one resolved address, honouring the RFC1918 allowance. */
function classifyAddress(ip: string, family: AddressFamily): EgressDenialReason | undefined {
  if (family === 4) {
    return classifyIpv4(ip);
  }
  const mapped = unwrapIpv4MappedIpv6(ip);
  if (mapped) {
    return classifyIpv4(mapped);
  }
  return classifyIpv6(ip);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validate an owner-supplied URL for outbound egress, resolving its host and
 * returning the concrete address to connect to (resolve-then-connect).
 *
 * RFC1918 addresses are explicitly ALLOWED (see module doc). Every other
 * non-public range — loopback, unspecified, link-local/metadata, IPv6
 * unique-local/metadata, multicast, reserved — is denied. A hostname that
 * resolves to more than one address is denied unless every resolved address
 * is allowed; the first allowed address is the one returned for pinning.
 */
export async function checkEgressTarget(rawUrl: string): Promise<EgressCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return deny('invalid_url', `'${rawUrl}' is not a valid URL`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return deny('invalid_scheme', `scheme '${url.protocol}' is not allowed — only http: and https: may be used`);
  }

  const rawHostname = url.hostname;
  if (!rawHostname) {
    return deny('invalid_host', 'URL has no host');
  }
  // WHATWG URL keeps the brackets on an IPv6 literal host (`[fe80::1]`);
  // `dns.lookup` (and every IP-literal check above) wants the bare address.
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  let addresses: { address: string; family: number }[];
  try {
    // A literal IP short-circuits with no network call; a hostname is
    // resolved for real. `all: true` surfaces every answer so none of them
    // can hide behind a "first one looked fine" check.
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    return deny('dns_resolution_failed', `could not resolve '${hostname}': ${err instanceof Error ? err.message : String(err)}`);
  }

  if (addresses.length === 0) {
    return deny('dns_resolution_failed', `'${hostname}' resolved to no addresses`);
  }

  for (const { address, family } of addresses) {
    const fam: AddressFamily = family === 6 ? 6 : 4;
    const denied = classifyAddress(address, fam);
    if (denied) {
      return deny(denied, `'${hostname}' resolves to ${address}, which is denied (${denied.replace(/_/g, ' ')})`);
    }
  }

  const first = addresses[0]!;
  const firstFamily: AddressFamily = first.family === 6 ? 6 : 4;
  return { ok: true, url, ip: first.address, family: firstFamily };
}

/** Exported for tests only — not part of the module's real contract. */
export const __internal = { isRfc1918, classifyAddress, expandIpv6 };
