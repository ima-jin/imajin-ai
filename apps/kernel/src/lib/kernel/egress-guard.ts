/**
 * SSRF egress guard for owner-supplied inference endpoints (#1957).
 *
 * The `local` inference connector is the first place the kernel ever fetches
 * a URL the OWNER typed in, rather than a hardcoded, trusted provider host.
 * That is a categorically different trust boundary from every other
 * `BRAIN_CONNECTORS` entry, and it is load-bearing: an unguarded fetch would
 * let any DID that can seal a `local` connector card point the kernel's own
 * network position at loopback, link-local, cloud-metadata, or (absent the
 * allowlist below) the platform's own private LAN.
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
 *   the AWS IMDSv6 metadata address (`fd00:ec2::254`), multicast, and
 *   IANA-reserved ranges are all denied UNCONDITIONALLY — no allowlist entry
 *   can ever re-open them.
 * - DNS rebinding (validate a hostname, then have its DNS record change
 *   before the connection is made) — this module resolves once and hands
 *   back the concrete address it validated; the caller (`egress-fetch.ts`,
 *   and `local`'s "host pin after first save" contract) is responsible for
 *   connecting to THAT address rather than re-resolving the hostname later.
 *
 * ## Private space is denied by default, not allowed by default
 * RFC1918 (`10/8`, `172.16/12`, `192.168/16`) and its IPv6 analogue,
 * unique-local addressing (`fc00::/7`), are exactly where Ollama/vLLM live
 * (the whole point of the connector) — but they are also the platform's own
 * LAN on a hosted, multi-tenant kernel. Without a gate, ANY DID that can
 * grant itself `local:infer` and save a `baseUrl` gets a read-SSRF primitive
 * into that LAN via `GET /local/api/models` (and every completions call) —
 * completely independent of who owns the DID. So private space is DENIED by
 * default, the same as every other non-public range, and an operator opts a
 * specific reachable range/host IN via `LOCAL_INFER_PRIVATE_ALLOWLIST`
 * (see {@link PRIVATE_ALLOWLIST_ENV_VAR}) — a comma-separated list of
 * `host[:port]` literals and/or CIDR blocks, or `*` to allow every private
 * address (the self-hosted / single-tenant setting, where the kernel's own
 * LAN and the owner's LAN are the same trust domain). Unset (the default)
 * denies all private space — a hosted operator must opt in explicitly.
 */
import { promises as dns } from 'node:dns';
import { isIPv4, isIPv6 } from 'node:net';

/** Address family, matching Node's own `net`/`dns` convention. */
export type AddressFamily = 4 | 6;

/**
 * The kernel env var operators use to reach into their own private LAN from
 * the `local` connector — see the module doc's "Private space is denied by
 * default" section. Named `LOCAL_INFER_*` to match the connector's own
 * `local:infer` scope, following the existing `VAULT_GRANT_TTL_DAYS`-style
 * convention of one focused env var per operator-set boundary.
 */
export const PRIVATE_ALLOWLIST_ENV_VAR = 'LOCAL_INFER_PRIVATE_ALLOWLIST';

/** Why a target was denied. Machine-readable, safe to log and to test against. */
export type EgressDenialReason =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'invalid_host'
  | 'dns_resolution_failed'
  | 'loopback'
  | 'unspecified'
  | 'link_local'
  | 'metadata'
  | 'multicast'
  | 'reserved'
  | 'private';

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
  if (a === 169 && b === 254) return 'link_local'; // covers 169.254.169.254 (cloud metadata) — unconditional, no allowlist
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240 || ip === '255.255.255.255') return 'reserved';
  if (isRfc1918(ip)) return 'private'; // allowlistable — see PRIVATE_ALLOWLIST_ENV_VAR
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
    return ip.split(':').map((h) => Number.parseInt(h, 16) || 0);
  }
  const [head, tail] = ip.split('::');
  const headParts = head ? head.split(':').filter(Boolean).map((h) => Number.parseInt(h, 16)) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean).map((h) => Number.parseInt(h, 16)) : [];
  const missing = 8 - headParts.length - tailParts.length;
  return [...headParts, ...(new Array(Math.max(missing, 0)).fill(0) as number[]), ...tailParts];
}

/**
 * AWS's IPv6 instance-metadata address, `fd00:ec2::254` — expanded to 8
 * hextets for direct comparison against `expandIpv6`'s output. It sits
 * inside `fc00::/7` (which is reclassified `private`/allowlistable below)
 * but must stay unconditionally denied, the same way `169.254.169.254`
 * (its IPv4 counterpart) stays denied as `link_local` regardless of any
 * private-range allowlist entry.
 */
const AWS_IMDS_V6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

function isAwsImdsV6(segments: readonly number[]): boolean {
  return AWS_IMDS_V6.every((seg, i) => (segments[i] ?? 0) === seg);
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

  if (isAwsImdsV6(segments)) return 'metadata'; // fd00:ec2::254 — unconditional, checked before the fc00::/7 private range below
  if ((first16 & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((first16 & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  // 100::/64 ("discard-only"), documented in RFC6666, is IANA-reserved.
  if (first16 === 0x0100 && second16 === 0) return 'reserved';
  if ((first16 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 (unique-local) — allowlistable, see PRIVATE_ALLOWLIST_ENV_VAR
  return undefined;
}

/** Classify one resolved address. `'private'` is the only reason an allowlist entry can override. */
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

// ── Operator private-range allowlist ────────────────────────────────────────

interface WildcardEntry { kind: 'wildcard' }
interface CidrEntry { kind: 'cidr'; family: AddressFamily; network: number | bigint; prefixLen: number }
/** A literal host (IP or hostname), matched against either the resolved IP or the original (pre-resolution) hostname. */
interface LiteralEntry { kind: 'literal'; host: string; port?: number }
type AllowlistEntry = WildcardEntry | CidrEntry | LiteralEntry;

function parseIpv4ToInt(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
    value = (value << 8) | n;
  }
  return value >>> 0;
}

function parseIpv6ToBigInt(ip: string): bigint {
  return expandIpv6(ip.toLowerCase()).reduce((acc, seg) => (acc << 16n) | BigInt(seg & 0xffff), 0n);
}

function ipv4InCidr(ip: string, network: number, prefixLen: number): boolean {
  const addr = parseIpv4ToInt(ip);
  if (addr === undefined) return false;
  if (prefixLen <= 0) return true;
  const mask = prefixLen >= 32 ? 0xffffffff : (0xffffffff << (32 - prefixLen)) >>> 0;
  return (addr & mask) >>> 0 === (network & mask) >>> 0;
}

function ipv6InCidr(ip: string, network: bigint, prefixLen: number): boolean {
  const addr = parseIpv6ToBigInt(ip);
  if (prefixLen <= 0) return true;
  const mask = prefixLen >= 128 ? (2n ** 128n) - 1n : (((1n << BigInt(prefixLen)) - 1n) << BigInt(128 - prefixLen));
  return (addr & mask) === (network & mask);
}

/** The CIDR half of `parseAllowlistEntry`: `10.0.0.0/8` / `fc00::/7`. */
function parseCidrEntry(entry: string): CidrEntry | undefined {
  const [network, prefixRaw] = entry.split('/');
  const prefixLen = Number(prefixRaw);
  if (!network || !Number.isInteger(prefixLen)) return undefined;

  if (isIPv4(network) && prefixLen >= 0 && prefixLen <= 32) {
    const addr = parseIpv4ToInt(network);
    return addr === undefined ? undefined : { kind: 'cidr', family: 4, network: addr, prefixLen };
  }
  if (isIPv6(network) && prefixLen >= 0 && prefixLen <= 128) {
    return { kind: 'cidr', family: 6, network: parseIpv6ToBigInt(network), prefixLen };
  }
  return undefined;
}

/**
 * The `host[:port]` half of `parseAllowlistEntry`. `host` may be an IP or a
 * hostname; a bracketed IPv6 host (`[fc00::1]:11434`) carries a port, a bare
 * (unbracketed) IPv6 literal never does (unambiguous port-splitting needs
 * the brackets).
 */
function parseLiteralEntry(entry: string): LiteralEntry | undefined {
  if (entry.startsWith('[')) {
    const closeIdx = entry.indexOf(']');
    if (closeIdx === -1) return undefined;
    const host = entry.slice(1, closeIdx);
    const rest = entry.slice(closeIdx + 1);
    if (!rest.startsWith(':')) return { kind: 'literal', host: host.toLowerCase(), port: undefined };
    const port = Number(rest.slice(1));
    return Number.isInteger(port) ? { kind: 'literal', host: host.toLowerCase(), port } : undefined;
  }

  // A bare entry with 0 or 2+ colons and no brackets is a plain hostname or a
  // bare IPv6 literal respectively — either way, no port.
  if ((entry.match(/:/g) ?? []).length !== 1) {
    return { kind: 'literal', host: entry.toLowerCase(), port: undefined };
  }
  const [host, portRaw] = entry.split(':');
  const port = Number(portRaw);
  return Number.isInteger(port) ? { kind: 'literal', host: host.toLowerCase(), port } : undefined;
}

/**
 * Parse one comma-separated entry of `LOCAL_INFER_PRIVATE_ALLOWLIST`:
 * `*` (wildcard), a CIDR block, or a `host[:port]` literal. Returns
 * `undefined` for a malformed entry, which is dropped rather than treated
 * as a syntax error — a typo in one entry must not silently disable the
 * ones around it, and any address it might have meant to name stays denied
 * by default either way.
 */
function parseAllowlistEntry(raw: string): AllowlistEntry | undefined {
  const entry = raw.trim();
  if (!entry) return undefined;
  if (entry === '*') return { kind: 'wildcard' };
  return entry.includes('/') ? parseCidrEntry(entry) : parseLiteralEntry(entry);
}

function loadAllowlistEntries(raw: string | undefined): AllowlistEntry[] {
  if (!raw) return [];
  return raw.split(',').map(parseAllowlistEntry).filter((e): e is AllowlistEntry => e !== undefined);
}

function matchesCidrEntry(entry: CidrEntry, ip: string, family: AddressFamily): boolean {
  if (entry.family !== family) return false;
  return family === 4
    ? ipv4InCidr(ip, entry.network as number, entry.prefixLen)
    : ipv6InCidr(ip, entry.network as bigint, entry.prefixLen);
}

function matchesLiteralEntry(entry: LiteralEntry, lowerIp: string, lowerHostname: string, port: number): boolean {
  if (entry.port !== undefined && entry.port !== port) return false;
  return entry.host === lowerIp || entry.host === lowerHostname;
}

/**
 * Whether a `'private'`-classified address is permitted by the operator's
 * allowlist. `ip` is checked against `cidr`/IP-shaped `literal` entries;
 * `hostname` (the original, pre-resolution host from the URL) is checked
 * against hostname-shaped `literal` entries — so an operator can allowlist
 * either "this exact address" or "this exact name", independent of DNS.
 */
function isPrivateAddressAllowed(
  entries: readonly AllowlistEntry[],
  ip: string,
  family: AddressFamily,
  hostname: string,
  port: number,
): boolean {
  const lowerIp = ip.toLowerCase();
  const lowerHostname = hostname.toLowerCase();
  return entries.some((entry) => {
    if (entry.kind === 'wildcard') return true;
    if (entry.kind === 'cidr') return matchesCidrEntry(entry, ip, family);
    return matchesLiteralEntry(entry, lowerIp, lowerHostname, port);
  });
}

// ── Public API ────────────────────────────────────────

interface ParsedTarget {
  url: URL;
  /** Bracket-stripped, ready for `dns.lookup`. */
  hostname: string;
  port: number;
}

/** Scheme + host validation, and WHATWG's IPv6-bracket/port normalisation — the synchronous half of {@link checkEgressTarget}. */
function parseTarget(rawUrl: string): { ok: true; value: ParsedTarget } | { ok: false; value: EgressDenyResult } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, value: deny('invalid_url', `'${rawUrl}' is not a valid URL`) };
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return { ok: false, value: deny('invalid_scheme', `scheme '${url.protocol}' is not allowed — only http: and https: may be used`) };
  }

  const rawHostname = url.hostname;
  if (!rawHostname) {
    return { ok: false, value: deny('invalid_host', 'URL has no host') };
  }

  // WHATWG URL keeps the brackets on an IPv6 literal host (`[fe80::1]`);
  // `dns.lookup` (and every IP-literal check above) wants the bare address.
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;

  return { ok: true, value: { url, hostname, port } };
}

/**
 * Classify every resolved address against the deny-list (honouring the
 * private-range allowlist), returning the first denial found or `undefined`
 * when every address is allowed.
 */
function findDenial(
  addresses: readonly { address: string; family: number }[],
  hostname: string,
  port: number,
  allowlist: readonly AllowlistEntry[],
): EgressDenyResult | undefined {
  for (const { address, family } of addresses) {
    const fam: AddressFamily = family === 6 ? 6 : 4;
    const denied = classifyAddress(address, fam);
    if (!denied) continue;
    if (denied === 'private' && isPrivateAddressAllowed(allowlist, address, fam, hostname, port)) {
      continue;
    }
    const remedy = denied === 'private' ? ` — not permitted unless allowlisted via ${PRIVATE_ALLOWLIST_ENV_VAR}` : '';
    return deny(denied, `'${hostname}' resolves to ${address}, which is denied (${denied.replace(/_/g, ' ')})${remedy}`);
  }
  return undefined;
}

/**
 * Validate an owner-supplied URL for outbound egress, resolving its host and
 * returning the concrete address to connect to (resolve-then-connect).
 *
 * Loopback, unspecified, link-local/metadata, multicast, and reserved
 * addresses are denied UNCONDITIONALLY. Private space (RFC1918 / `fc00::/7`)
 * is denied BY DEFAULT and allowed only for addresses/hosts/ranges named in
 * `LOCAL_INFER_PRIVATE_ALLOWLIST` (see the module doc and
 * {@link PRIVATE_ALLOWLIST_ENV_VAR}). A hostname that resolves to more than
 * one address is denied unless every resolved address is allowed; the first
 * allowed address is the one returned for pinning.
 */
export async function checkEgressTarget(rawUrl: string): Promise<EgressCheckResult> {
  const parsed = parseTarget(rawUrl);
  if (!parsed.ok) return parsed.value;
  const { hostname, port, url } = parsed.value;

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

  const allowlist = loadAllowlistEntries(process.env[PRIVATE_ALLOWLIST_ENV_VAR]);
  const denial = findDenial(addresses, hostname, port, allowlist);
  if (denial) return denial;

  const first = addresses[0]!;
  const firstFamily: AddressFamily = first.family === 6 ? 6 : 4;
  return { ok: true, url, ip: first.address, family: firstFamily };
}

/** Exported for tests only — not part of the module's real contract. */
export const __internal = {
  isRfc1918,
  classifyAddress,
  expandIpv6,
  parseAllowlistEntry,
  loadAllowlistEntries,
  isPrivateAddressAllowed,
};
