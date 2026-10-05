import { NextResponse } from 'next/server';
import { getAttestationForwardFailureCount } from '@imajin/auth';

export function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'auth',
    version: process.env.NEXT_PUBLIC_VERSION || '0.0.0',
    build: process.env.NEXT_PUBLIC_BUILD_HASH || 'dev',
    timestamp: new Date().toISOString(),
    // Non-2xx responses from emitAttestation()'s forward to
    // /api/attestations/internal or /api/attestations/chain-emit since
    // process start (#2037) — a sustained non-zero count usually means
    // ATTESTATION_INTERNAL_API_KEY is misconfigured or mismatched.
    attestationForwardFailures: getAttestationForwardFailureCount(),
  });
}
