/**
 * Client helper for #2394: a registered third-party app submitting an
 * attestation delegated by one of its end users (payload.delegator_did),
 * signed with the APP's own Ed25519 key and authenticated to the kernel
 * with a scoped app-token (POST {authUrl}/auth/api/tokens/app — see
 * @imajin/auth-client's requestAppToken — per Ryan's 2026-09-26 ruling)
 * rather than the app's own kernel session.
 *
 * This mirrors, byte for byte, the canonical form and signature scheme
 * POST {authUrl}/api/attestations verifies server-side
 * (apps/kernel/app/auth/api/attestations/route.ts) so a caller never has to
 * hand-derive it. It does NOT request the delegation grant itself — that
 * step requires the delegator's own kernel session (POST /auth/api/grants,
 * capability `attest:<appId>:<type>`, see grant-scopes.ts's
 * buildAttestDelegationCapability) and currently has no consent UI (a gap
 * issue was filed for that, refs #2394).
 */
import { canonicalize } from './sign';
import { signSync } from './crypto';

export interface DelegatedAttestationInput {
  /** The kernel's own base URL, e.g. https://jin.imajin.ai/auth */
  authUrl: string;
  /** A scoped app-token (POST {authUrl}/api/tokens/app) authenticating this call (#2394). */
  appToken: string;
  /** This app's own DID — becomes `issuer_did`; must be a registry.apps row's app_did. */
  appDid: string;
  /** This app's own Ed25519 private key (hex), matching registry.apps.publicKey for `appDid`. */
  appPrivateKey: string;
  /** The end user this attestation is delegated by — `payload.delegator_did`. */
  delegatorDid: string;
  subjectDid: string;
  type: string;
  contextId?: string | null;
  contextType?: string | null;
  /** Additional payload fields, merged with `delegator_did`. */
  payload?: Record<string, unknown>;
  issuedAt?: number;
}

export interface DelegatedAttestationResult {
  ok: boolean;
  status: number;
  attestation?: Record<string, unknown>;
  error?: string;
}

/**
 * Sign and submit a delegated attestation on `delegatorDid`'s behalf. The
 * app must already hold BOTH a scoped app-token for its own audience AND a
 * live `attest:<appId>:<type>` delegation grant from `delegatorDid` — this
 * helper only constructs, signs, and submits the request.
 */
export async function submitDelegatedAttestation(
  input: DelegatedAttestationInput,
): Promise<DelegatedAttestationResult> {
  const issuedAtMs = input.issuedAt ?? Date.now();
  const payload = { ...input.payload, delegator_did: input.delegatorDid };
  const contextId = input.contextId ?? null;
  const contextType = input.contextType ?? null;

  // Canonical form MUST match apps/kernel/app/auth/api/attestations/route.ts's
  // own canonicalize({ subject_did, type, context_id, context_type, payload,
  // issued_at }) exactly — any drift here would sign a payload the kernel
  // can never verify.
  const canonicalPayload = canonicalize({
    subject_did: input.subjectDid,
    type: input.type,
    context_id: contextId,
    context_type: contextType,
    payload,
    issued_at: issuedAtMs,
  });
  const signature = signSync(canonicalPayload, input.appPrivateKey);

  try {
    const res = await fetch(`${input.authUrl}/api/attestations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.appToken}`,
      },
      body: JSON.stringify({
        issuer_did: input.appDid,
        subject_did: input.subjectDid,
        type: input.type,
        context_id: contextId,
        context_type: contextType,
        payload,
        signature,
        issued_at: issuedAtMs,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: (body as { error?: string }).error ?? 'Failed to submit delegated attestation' };
    }
    return { ok: true, status: res.status, attestation: body as Record<string, unknown> };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : 'Network error' };
  }
}
