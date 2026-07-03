/**
 * Lazy get-or-create identity core (Issue #1230).
 *
 * Pure orchestration for `POST /registry/api/identity`, decoupled from Drizzle
 * so the idempotency + concurrency behavior can be tested against an in-memory
 * repository. The route supplies a DB-backed {@link IdentityAliasRepo}.
 */

export interface ResolveIdentityInput {
  namespace: string;
  ref: string;
  type: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface ResolveIdentityResult {
  did: string;
  created: boolean;
  metadata: Record<string, unknown>;
  /** True only when this call minted the DID — signals the route to emit provenance. */
  minted: boolean;
}

export interface ResolveIdentityError {
  error: string;
  status: number;
}

/**
 * Storage operations the resolver needs. Implementations must enforce the
 * unique `(namespace, ref)` constraint inside {@link claimAlias}.
 */
export interface IdentityAliasRepo {
  /** Return the DID mapped to `(namespace, ref)`, or null if unmapped. */
  findAlias(namespace: string, ref: string): Promise<string | null>;
  /**
   * Attempt to claim `(namespace, ref)` for `did`. Returns true when this call
   * won the row, false on conflict (another concurrent first-reference won).
   */
  claimAlias(namespace: string, ref: string, did: string): Promise<boolean>;
  /** Create the soft identity backing a freshly claimed alias; returns its stored metadata. */
  createIdentity(did: string, type: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Return an existing identity's metadata, or null if the identity is missing. */
  getIdentityMetadata(did: string): Promise<Record<string, unknown> | null>;
  /** Additively merge `incoming` into an existing identity's metadata; returns the merged result. */
  mergeMetadata(did: string, incoming: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
  /** Generate a fresh soft DID (`did:imajin:<nanoid(44)>`). */
  mintDid(): string;
}

function isError(value: ResolveIdentityResult | ResolveIdentityError): value is ResolveIdentityError {
  return 'error' in value;
}

/** Load an existing identity and additively merge any new metadata. */
async function resolveExisting(
  repo: IdentityAliasRepo,
  did: string,
  incoming: Readonly<Record<string, unknown>>,
): Promise<ResolveIdentityResult | ResolveIdentityError> {
  const current = await repo.getIdentityMetadata(did);
  if (current === null) {
    return { error: 'Identity not found for alias', status: 500 };
  }

  let metadata = current;
  if (Object.keys(incoming).length > 0) {
    metadata = await repo.mergeMetadata(did, incoming);
  }

  return { did, created: false, metadata, minted: false };
}

/**
 * Resolve `(namespace, ref)` to a canonical DID, minting a soft identity on the
 * first reference. Idempotent: the same key always returns the same DID, and
 * concurrent first-references collapse to a single mint via {@link IdentityAliasRepo.claimAlias}.
 */
export async function resolveOrMintIdentity(
  repo: IdentityAliasRepo,
  input: ResolveIdentityInput,
): Promise<ResolveIdentityResult | ResolveIdentityError> {
  const { namespace, ref, type, metadata: incoming } = input;

  // 1. Existing alias → idempotent hit.
  const existing = await repo.findAlias(namespace, ref);
  if (existing !== null) {
    return resolveExisting(repo, existing, incoming);
  }

  // 2. Claim the pair first (conflict-safe) so a lost race never orphans an identity.
  const did = repo.mintDid();
  const won = await repo.claimAlias(namespace, ref, did);

  if (!won) {
    const winner = await repo.findAlias(namespace, ref);
    if (winner === null) {
      return { error: 'Failed to resolve identity', status: 500 };
    }
    return resolveExisting(repo, winner, incoming);
  }

  // 3. We won the claim → mint the soft identity behind it.
  const stored = await repo.createIdentity(did, type, { ...incoming, type, aliasNamespace: namespace });
  return { did, created: true, metadata: stored, minted: true };
}

export { isError as isResolveIdentityError };
