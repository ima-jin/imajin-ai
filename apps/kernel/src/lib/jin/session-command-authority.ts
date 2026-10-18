import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { createDbResolver } from '@imajin/auth/resolve-db';
import { db, identities } from '@/src/db';
import { listServiceOf } from '@/src/lib/auth/agent-service';
import { readLoopCommandProof } from './session-command-store';
import { sessionAttestationSchema, sessionOutcomeSchema } from './session-command-contract';

export class SessionCommandError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export async function currentIdentityPublicKey(did: string): Promise<string> {
  const identity = await createDbResolver(db, identities)(did);
  if (!identity?.publicKey) throw new SessionCommandError('Current identity key unavailable', 403);
  return identity.publicKey;
}

export async function requireSessionAgent(agentDid: string, principal: string): Promise<string> {
  if (!(await listServiceOf(agentDid)).includes(principal)) {
    throw new SessionCommandError('Agent no longer serves principal', 403);
  }
  return currentIdentityPublicKey(agentDid);
}

function verifyLifecycleProof(proof: unknown, type: string, issuer: string, key: string, loopId: string, principal: string): boolean {
  if (!proof || typeof proof !== 'object') return false;
  const p = proof as { type?: string; publisherDid?: string; signature?: { keyId: string; alg: string; sig: string }; payload?: { loopId?: string; principal?: string } };
  if (p.type !== type || p.publisherDid !== issuer || p.payload?.loopId !== loopId || p.payload?.principal !== principal) return false;
  const signature = p.signature;
  return signature?.alg === 'ed25519' && signature.keyId === key
    && authCrypto.verifySync(signature.sig, canonicalize({ type: p.type, payload: p.payload }), key);
}

function verifySpawnProof(raw: unknown, issuer: string, key: string, loopId: string, principal: string): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const { attestation } = raw as { attestation?: unknown };
  const parsed = sessionAttestationSchema.safeParse(attestation);
  if (!parsed.success) return false;
  const { signature, ...signed } = parsed.data;
  const outcome = sessionOutcomeSchema.safeParse(signed.payload);
  return signed.from === issuer && outcome.success && outcome.data.principal === principal
    && outcome.data.command === 'session.spawn' && outcome.data.outcome === 'completed'
    && outcome.data.loopId === loopId && outcome.data.childLoopId === loopId
    && authCrypto.verifySync(signature, canonicalize(signed), key);
}
function proofParentMatches(row: Record<string, unknown>, parent: unknown): boolean {
  const proof = row.proof as { payload?: { parentLoopId?: string | null } } | null;
  const spawn = row.spawn_proof as { attestation?: { payload?: { parentLoopId?: string | null } } } | null;
  return (spawn?.attestation?.payload?.parentLoopId ?? proof?.payload?.parentLoopId ?? null) === (parent ?? null);
}

/** All lifecycle publishers must agree with the verified origin, not the latest convenient issuer. */
export async function resolveSessionCommandTarget(loopId: string, principal: string): Promise<string> {
  const { loop, proofs } = await readLoopCommandProof(loopId, principal);
  if (!loop) throw new SessionCommandError('Run not found', 404);
  if (loop.finished_at || !['running', 'active', 'blocked'].includes(loop.state)) throw new SessionCommandError('Run is not active', 409);
  if (proofs.length === 0 || proofs.length > 1000) throw new SessionCommandError('Origin proof unavailable', 409);
  const issuers = new Set(proofs.map(row => row.issuer as string));
  if (issuers.size !== 1) throw new SessionCommandError('Ambiguous run publisher', 409);
  const issuer = proofs[0].issuer as string;
  const key = await requireSessionAgent(issuer, principal);
  const origins = proofs.filter(row => row.type === 'loop.started');
  if (origins.length === 0) throw new SessionCommandError('Origin proof unavailable', 409);
  const verified = proofs.every(row => {
    if (row.type !== 'loop.started' && !row.proof && !row.spawn_proof) return true;
    return proofParentMatches(row, loop.parent_loop_id) && (row.spawn_proof
      ? verifySpawnProof(row.spawn_proof, issuer, key, loopId, principal)
      : verifyLifecycleProof(row.proof, row.type, issuer, key, loopId, principal));
  });
  if (!verified) throw new SessionCommandError('Run publisher proof is stale or invalid', 403);
  return issuer;
}
