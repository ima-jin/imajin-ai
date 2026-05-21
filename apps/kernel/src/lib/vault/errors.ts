import { IntegrityErrorCode, VaultIntegrityError } from '@imajin/vault-core';
import { NextResponse } from 'next/server';

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

  return NextResponse.json({ error: fallbackError }, { status: fallbackStatus });
}
