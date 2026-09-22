import { NextResponse } from 'next/server';
import { getKernelSigningKeyDocument } from '@/src/lib/auth/kernel-signing-key';

/**
 * GET /auth/.well-known/kernel-signing-key (#2244, child of epic #2241).
 *
 * Unauthenticated, cacheable publication of the kernel's Ed25519 signing
 * public key(s) — the same key `CorpusAccessClaim`s are signed with
 * (`apps/kernel/src/lib/kernel/corpus-access-claim.ts`). Lets a consumer
 * fetch-and-pin (TOFU) this value instead of an operator hand-copying it
 * into `CORPUS_KERNEL_PUBLIC_KEY` (#2024). Documented in
 * `api-spec/auth.yaml` so `GET /auth/api/spec` also discovers it.
 *
 * Multi-key shape (`{ keys: [...], current }`) supports serving both the
 * current and a just-rotated-out key during a grace window — see
 * `src/lib/auth/kernel-signing-key.ts`'s module comment.
 *
 * `AUTH_PRIVATE_KEY` reads a runtime env var, so this handler must not be
 * statically rendered (matches `.well-known/agent.json`'s `nodeUrl()` note).
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const document = getKernelSigningKeyDocument();

  if (!document) {
    return NextResponse.json(
      { error: 'kernel signing key not configured' },
      { status: 503, headers: { 'Access-Control-Allow-Origin': '*' } },
    );
  }

  return NextResponse.json(document, {
    headers: {
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
