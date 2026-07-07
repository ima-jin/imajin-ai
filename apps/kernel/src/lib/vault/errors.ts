import { IntegrityErrorCode, VaultIntegrityError } from '@imajin/vault-core';
import { NextResponse } from 'next/server';

/**
 * Thrown by loadAndUnseal when a delegation-grant entry has no active grant
 * for the requesting node, or when the grant's owner signature is invalid.
 *
 * Distinct from VaultIntegrityError so callers can handle "no grant" separately
 * from "tampered entry" without catching a broad error type.
 */
export class VaultDelegationError extends Error {
  public readonly field: string;
  public readonly nodeDid: string;

  constructor(
    message: string,
    context: { field: string; nodeDid: string },
  ) {
    super(message);
    this.name = 'VaultDelegationError';
    this.field = context.field;
    this.nodeDid = context.nodeDid;
  }
}

function statusForIntegrityCode(code: IntegrityErrorCode): number {
  switch (code) {
    case IntegrityErrorCode.SIGNATURE_INVALID:
      return 401;
    case IntegrityErrorCode.DID_KEY_BINDING_INVALID:
      return 403;
    case IntegrityErrorCode.CID_MISMATCH:
    case IntegrityErrorCode.KEY_ID_MISMATCH:
      return 409;
    case IntegrityErrorCode.UNSUPPORTED_VERSION:
    case IntegrityErrorCode.MISSING_REQUIRED_FIELD:
    case IntegrityErrorCode.INVALID_TIMESTAMP:
    default:
      return 400;
  }
}

export function toVaultErrorResponse(
  error: unknown,
  fallbackError: string,
  fallbackStatus: number
): NextResponse {
  if (error instanceof VaultIntegrityError) {
    return NextResponse.json(
      {
        error: 'Vault integrity verification failed',
        code: error.code,
        field: error.entryField ?? null,
        details: error.details ?? null,
      },
      { status: statusForIntegrityCode(error.code) }
    );
  }

  if (error instanceof VaultDelegationError) {
    return NextResponse.json(
      { error: 'No active delegation grant', field: error.field },
      { status: 403 }
    );
  }

  return NextResponse.json({ error: fallbackError }, { status: fallbackStatus });
}
