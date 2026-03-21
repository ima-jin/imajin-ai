import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, getSessionCookieOptions, SessionPayload } from './jwt';
import { verifyChain } from '@imajin/dfos';
import { hexToMultibase } from '@imajin/auth';
import { db, identityChains, identities } from '@/src/db';
import { eq } from 'drizzle-orm';

interface AuthOptions {
  /** If true, verify identity against DFOS chain (not just DB) */
  verifyChain?: boolean;
}

/**
 * Middleware helper to require authentication (soft or hard DID)
 *
 * Usage:
 * const session = await requireAuth(request);
 * if (!session) {
 *   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
 * }
 *
 * With chain verification (opt-in):
 * const session = await requireAuth(request, { verifyChain: true });
 */
export async function requireAuth(
  request: NextRequest,
  options?: AuthOptions
): Promise<SessionPayload | null> {
  const cookieConfig = getSessionCookieOptions();
  const token = request.cookies.get(cookieConfig.name)?.value;

  if (!token) {
    return null;
  }

  const session = await verifySessionToken(token);
  if (!session) {
    return null;
  }

  // Optional chain verification — OFF by default
  if (options?.verifyChain) {
    const chainValid = await verifyIdentityChain(session.did);
    if (!chainValid) {
      console.error('[auth] Chain verification failed for', session.did);
      return null;
    }
  }

  return session;
}

/**
 * Verify an identity's DFOS chain and check key consistency with DB.
 * Returns true if chain is valid and keys match, or if no chain exists (non-fatal).
 */
async function verifyIdentityChain(did: string): Promise<boolean> {
  try {
    const [chain] = await db
      .select()
      .from(identityChains)
      .where(eq(identityChains.did, did))
      .limit(1);

    // No chain = not bridged. Non-fatal — verification not applicable.
    if (!chain) return true;

    // Verify chain cryptographically
    const verified = await verifyChain(chain.log as string[]);

    if (verified.isDeleted) {
      console.error('[auth] Identity chain is deleted:', did);
      return false;
    }

    // Check key consistency: chain controller key should match DB public key
    const [identity] = await db
      .select({ publicKey: identities.publicKey })
      .from(identities)
      .where(eq(identities.id, did))
      .limit(1);

    if (!identity) return false;

    const dbMultibase = hexToMultibase(identity.publicKey);
    const chainMultibase = verified.controllerKeys[0]?.publicKeyMultibase;

    if (dbMultibase !== chainMultibase) {
      console.error('[auth] Key mismatch — DB vs chain for', did);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[auth] Chain verification error:', err);
    return false;
  }
}

/**
 * Middleware helper to require hard DID authentication (keypair-based)
 *
 * Usage:
 * const session = await requireHardDID(request);
 * if (!session) {
 *   return NextResponse.json({ error: 'Hard DID required' }, { status: 403 });
 * }
 */
export async function requireHardDID(request: NextRequest): Promise<SessionPayload | null> {
  const session = await requireAuth(request);

  if (!session) {
    return null;
  }

  // Check if this is a hard DID
  if (session.tier === 'soft') {
    return null;
  }

  return session;
}

/**
 * Require an assert key session (signing content, attestations, .fair).
 * Legacy tokens (no keyRole) pass — single key does everything.
 */
export async function requireAssertKey(request: NextRequest): Promise<SessionPayload | null> {
  const session = await requireAuth(request);
  if (!session) return null;

  // Legacy tokens (no key role) — single key does everything
  if (!session.keyRole) return session;

  if (session.keyRole !== 'assert' && session.keyRole !== 'controller') {
    return null; // auth-only key can't sign content
  }
  return session;
}

/**
 * Require a controller key session (rotation, deletion, fund transfers).
 * Legacy tokens (no keyRole) pass — single key does everything.
 */
export async function requireControllerKey(request: NextRequest): Promise<SessionPayload | null> {
  const session = await requireAuth(request);
  if (!session) return null;

  // Legacy tokens (no key role) — single key does everything
  if (!session.keyRole) return session;

  if (session.keyRole !== 'controller') {
    return null;
  }
  return session;
}

/**
 * Helper to create a JSON response with authentication error
 */
export function unauthorizedResponse(message = 'Authentication required') {
  return NextResponse.json({ error: message }, { status: 401 });
}

/**
 * Helper to create a JSON response with hard DID requirement error
 */
export function hardDIDRequiredResponse(message = 'This action requires a full identity (hard DID)') {
  return NextResponse.json({
    error: message,
    upgradeRequired: true,
  }, { status: 403 });
}
