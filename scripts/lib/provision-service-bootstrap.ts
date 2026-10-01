/**
 * scripts/lib/provision-service-bootstrap.ts (#2442)
 *
 * Core of `scripts/provision-service-bootstrap.ts`: provisions each userspace
 * service's vault bootstrap identity (`<SVC>_VAULT_BOOTSTRAP_DID` /
 * `_PRIVATE_KEY`) and ensures it holds the `ATTESTATION_INTERNAL_API_KEY`
 * grant (#2353).
 *
 * Contract:
 *  - Services are discovered from `apps/*\/.env.example`, never hardcoded;
 *    a pair annotated `# optional` there (corpus) is not provisioned.
 *  - Both keys present and non-empty in `apps/<svc>/.env.local` → left
 *    untouched (never rotated, never overwritten).
 *  - Exactly one present, or either empty → error, before anything is
 *    minted, written or granted.
 *  - No `.env.local` at all → the service isn't configured on this host:
 *    skipped. Creating a stub would flip scripts/check-env.ts from "warn" to a
 *    hard error for a service that isn't deployed here (e.g. corpus on prod).
 *  - Both absent → mint an Ed25519 keypair + `did:imajin:*` DID with
 *    `@imajin/auth`'s existing primitives, register it as a kernel identity
 *    (the vault fetch authenticates by challenge/response against
 *    `auth.identities`), append the pair to `.env.local` atomically (0600).
 *  - The grant is ensured for EVERY service whose pair now exists, so a crash
 *    between the write and the grant self-heals on the next run.
 *
 * The private key is never returned, logged or placed in an error message.
 * The DB/vault side effects are injected ({@link ProvisionDeps}) so the
 * orchestration can be tested without a database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export type ProvisionStatus = 'minted' | 'existing';

export interface ProvisionResult {
  service: string;
  did: string;
  status: ProvisionStatus;
  grantId: string;
}

export interface BootstrapService {
  /** Directory name under `apps/` — what the operator passes as `<service>`. */
  name: string;
  didKey: string;
  privateKeyKey: string;
}

export interface MintedIdentity {
  did: string;
  publicKey: string;
  privateKey: string;
}

export interface ProvisionDeps {
  mintIdentity(): Promise<MintedIdentity>;
  /** The DID + public key `privateKey` derives, or null when it can't be derived. */
  identityFromPrivateKey(privateKey: string): Promise<{ did: string; publicKey: string } | null>;
  /** Idempotent insert into the kernel's `auth.identities`. */
  registerIdentity(identity: { did: string; publicKey: string; name: string }): Promise<void>;
  /** Idempotent grant of the attestation internal API key. */
  ensureGrant(did: string): Promise<{ status: string; grantId?: string }>;
}

const DID_SUFFIX = '_VAULT_BOOTSTRAP_DID';
const PRIVATE_KEY_SUFFIX = '_VAULT_BOOTSTRAP_PRIVATE_KEY';
const DID_PREFIX = 'did:imajin:';

const GRANT_FAILURES: Record<string, string> = {
  tier1_unsupported: 'this vault runs in Tier 1 (external owner agent) mode, which the grant path does not support',
  no_reusable_grant: 'no reusable grant material found for the attestation key',
};

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * The `<SVC>` prefix of a `<SVC>_VAULT_BOOTSTRAP_DID=` line, or null when the
 * file has none or marks it `# optional` (scripts/check-env.ts's annotation:
 * the pair may legitimately be absent, so it is not ours to mint — e.g.
 * corpus's, which is provisioned by hand).
 */
function requiredBootstrapPrefix(exampleContent: string): string | null {
  const lines = exampleContent.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const prefix = /^([A-Z][A-Z0-9_]*)_VAULT_BOOTSTRAP_DID=/.exec(line)?.[1];
    if (!prefix) continue;
    const annotation = lines[index - 1]?.trim().toLowerCase();
    return annotation === '# optional' ? null : prefix;
  }
  return null;
}

/** Every `apps/<dir>/.env.example` that declares a required `<SVC>_VAULT_BOOTSTRAP_DID`, sorted by directory name. */
export function discoverServices(repoRoot: string): BootstrapService[] {
  const appsDir = path.join(repoRoot, 'apps');
  const services: BootstrapService[] = [];
  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const examplePath = path.join(appsDir, entry.name, '.env.example');
    if (!fs.existsSync(examplePath)) continue;
    const prefix = requiredBootstrapPrefix(fs.readFileSync(examplePath, 'utf8'));
    if (!prefix) continue;
    services.push({
      name: entry.name,
      didKey: `${prefix}${DID_SUFFIX}`,
      privateKeyKey: `${prefix}${PRIVATE_KEY_SUFFIX}`,
    });
  }
  return services.sort((a, b) => a.name.localeCompare(b.name));
}

// ── .env.local reading / writing ─────────────────────────────────────────────

function parseEnvValue(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1);
  }
  return value;
}

/** Key → value of every assignment line; comments and blank lines are ignored, the last assignment wins. */
export function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=(.*)$/.exec(line);
    if (match) entries.set(match[1]!, parseEnvValue(match[2]!));
  }
  return entries;
}

function envLocalPath(repoRoot: string, service: BootstrapService): string {
  return path.join(repoRoot, 'apps', service.name, '.env.local');
}

function readEnvLocal(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/**
 * Append `additions` to `file`, preserving existing content byte-for-byte,
 * via temp file + rename, mode 0600.
 */
export function appendEnvAtomically(file: string, additions: ReadonlyArray<readonly [string, string]>): void {
  const existing = readEnvLocal(file);
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  const content = existing + separator + additions.map(([key, value]) => `${key}=${value}\n`).join('');

  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// ── Pair validation ──────────────────────────────────────────────────────────

type KeyState = 'absent' | 'empty' | 'set';

function keyState(env: Map<string, string>, key: string): KeyState {
  if (!env.has(key)) return 'absent';
  return env.get(key)!.trim() === '' ? 'empty' : 'set';
}

type PairState =
  | { kind: 'no-env-local' }
  | { kind: 'missing' }
  | { kind: 'existing'; did: string; privateKey: string }
  | { kind: 'invalid'; error: string };

function inspectPair(repoRoot: string, service: BootstrapService): PairState {
  const file = envLocalPath(repoRoot, service);
  if (!fs.existsSync(file)) return { kind: 'no-env-local' };
  const env = parseEnvFile(readEnvLocal(file));
  const didState = keyState(env, service.didKey);
  const keyStateOfPrivate = keyState(env, service.privateKeyKey);

  if (didState === 'absent' && keyStateOfPrivate === 'absent') return { kind: 'missing' };

  if (didState !== 'set' || keyStateOfPrivate !== 'set') {
    return {
      kind: 'invalid',
      error:
        `${service.name}: apps/${service.name}/.env.local must define both ${service.didKey} and ` +
        `${service.privateKeyKey} (non-empty), or neither — found ${service.didKey} ${didState}, ` +
        `${service.privateKeyKey} ${keyStateOfPrivate}. Nothing was changed; fix the file by hand ` +
        `(a half-written pair is never repaired automatically, to avoid rotating a live identity).`,
    };
  }

  const did = env.get(service.didKey)!.trim();
  if (!did.startsWith(DID_PREFIX)) {
    return {
      kind: 'invalid',
      error: `${service.name}: ${service.didKey} in apps/${service.name}/.env.local must start with '${DID_PREFIX}'.`,
    };
  }
  return { kind: 'existing', did, privateKey: env.get(service.privateKeyKey)!.trim() };
}

// ── Provisioning ─────────────────────────────────────────────────────────────

async function ensureGrantOrThrow(deps: ProvisionDeps, service: BootstrapService, did: string): Promise<string> {
  const outcome = await deps.ensureGrant(did);
  if (outcome.status === 'ok' && outcome.grantId) return outcome.grantId;
  throw new Error(
    `${service.name}: could not ensure the ATTESTATION_INTERNAL_API_KEY grant for ${did}: ` +
      (GRANT_FAILURES[outcome.status] ?? `unexpected grant outcome '${outcome.status}'`),
  );
}

async function provisionMissing(
  repoRoot: string,
  service: BootstrapService,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const identity = await deps.mintIdentity();
  await deps.registerIdentity({
    did: identity.did,
    publicKey: identity.publicKey,
    name: `${service.name} vault bootstrap`,
  });
  appendEnvAtomically(envLocalPath(repoRoot, service), [
    [service.didKey, identity.did],
    [service.privateKeyKey, identity.privateKey],
  ]);
  const grantId = await ensureGrantOrThrow(deps, service, identity.did);
  return { service: service.name, did: identity.did, status: 'minted', grantId };
}

async function provisionExisting(
  service: BootstrapService,
  pair: { did: string; privateKey: string },
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  // Self-heal a crash between the write and the registration: re-register the
  // identity (idempotent) when the DID is the one the private key derives.
  // A DID minted some other way is left as it is — only the grant is ensured.
  const derived = await deps.identityFromPrivateKey(pair.privateKey);
  if (derived?.did === pair.did) {
    await deps.registerIdentity({
      did: derived.did,
      publicKey: derived.publicKey,
      name: `${service.name} vault bootstrap`,
    });
  }
  const grantId = await ensureGrantOrThrow(deps, service, pair.did);
  return { service: service.name, did: pair.did, status: 'existing', grantId };
}

/**
 * Provision `services` (in order). Every pair is validated first, so a bad
 * `.env.local` fails the run before any identity is minted, written or
 * granted. `onResult` fires as each service completes, so a caller can emit
 * progress even when a later service fails; `onSkip` fires for a service with
 * no `.env.local`.
 */
export async function provisionServices(
  repoRoot: string,
  services: readonly BootstrapService[],
  deps: ProvisionDeps,
  onResult: (result: ProvisionResult) => void = () => {},
  onSkip: (service: BootstrapService) => void = () => {},
): Promise<ProvisionResult[]> {
  const pairs = services.map((service) => ({ service, pair: inspectPair(repoRoot, service) }));

  const errors = pairs.flatMap(({ pair }) => (pair.kind === 'invalid' ? [pair.error] : []));
  if (errors.length > 0) throw new Error(errors.join('\n'));

  // Strictly one service at a time: the first grant for a purpose self-provisions
  // the shared secret (getInternalSecret), which must not race itself.
  const results: ProvisionResult[] = [];
  await pairs.reduce<Promise<void>>(async (previous, { service, pair }) => {
    await previous;
    if (pair.kind === 'no-env-local') {
      onSkip(service);
      return;
    }
    const result =
      pair.kind === 'existing'
        ? await provisionExisting(service, pair, deps)
        : await provisionMissing(repoRoot, service, deps);
    results.push(result);
    onResult(result);
  }, Promise.resolve());
  return results;
}

/** `service · did · minted|existing · grantId` — never carries key material. */
export function formatResult(result: ProvisionResult): string {
  return `${result.service} · ${result.did} · ${result.status} · ${result.grantId}`;
}

// ── Real dependencies (kernel DB / vault) ────────────────────────────────────

/**
 * The production {@link ProvisionDeps}. Kernel modules are imported lazily so
 * argument/`.env.local` validation errors surface without needing a database,
 * and `@imajin/auth` is imported dynamically for the ESM-only resolution
 * reason documented in scripts/bootstrap-corpus-identity.ts (#1711).
 */
export function createKernelDeps(grantedBy: string): ProvisionDeps {
  return {
    async mintIdentity() {
      const { generateKeypair, createDID } = await import('@imajin/auth');
      const keypair = generateKeypair();
      return { did: createDID(keypair.publicKey), publicKey: keypair.publicKey, privateKey: keypair.privateKey };
    },

    async identityFromPrivateKey(privateKey) {
      const { getPublicKey, createDID } = await import('@imajin/auth');
      try {
        const publicKey = getPublicKey(privateKey);
        return { did: createDID(publicKey), publicKey };
      } catch {
        return null;
      }
    },

    async registerIdentity({ did, publicKey, name }) {
      const { db, identities } = await import('../../apps/kernel/src/db/index.js');
      await db
        .insert(identities)
        .values({ id: did, scope: 'actor', subtype: 'service', publicKey, name, tier: 'preliminary' })
        .onConflictDoNothing();
    },

    async ensureGrant(did) {
      const { ensureAttestationInternalApiKeyGrant } = await import('./attestation-internal-api-key-grant.js');
      return ensureAttestationInternalApiKeyGrant(did, grantedBy);
    },
  };
}
