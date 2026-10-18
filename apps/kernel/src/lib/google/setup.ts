import { eq, sql } from 'drizzle-orm';
import { db, identities } from '@/src/db';
import { currentConnectionSlot } from '@/src/lib/kernel/connector-connection-context';
import { connectionSlot } from '@/src/lib/kernel/connection-slots';
import {
  GOOGLE_SETUP_STEPS, GOOGLE_SETUP_STATUSES, GOOGLE_SETUP_VERSION,
  type GoogleSetupState, type GoogleSetupStepId, type GoogleSetupStepState,
} from './setup-content';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function decodeGoogleSetup(value: unknown): GoogleSetupState {
  const saved = object(object(value).steps);
  const steps = {} as GoogleSetupState['steps'];
  for (const { id } of GOOGLE_SETUP_STEPS) {
    const step = object(saved[id]);
    steps[id] = {
      status: typeof step.status === 'string' && Object.hasOwn(GOOGLE_SETUP_STATUSES, step.status)
        ? step.status as GoogleSetupStepState['status'] : 'not_started',
      updatedAt: typeof step.updatedAt === 'string' ? step.updatedAt : null,
      pendingSince: typeof step.pendingSince === 'string' ? step.pendingSince : null,
      ...(typeof step.caseUrl === 'string' ? { caseUrl: step.caseUrl } : {}),
    };
  }
  return { version: GOOGLE_SETUP_VERSION, steps };
}

export function nextGoogleSetupStep(
  previous: GoogleSetupStepState,
  status: GoogleSetupStepState['status'],
  now: string,
  caseUrl?: string,
): GoogleSetupStepState {
  let pendingSince: string | null = null;
  if (status === 'pending_google') {
    pendingSince = now;
    if (previous.status === 'pending_google') pendingSince = previous.pendingSince ?? now;
  }
  const savedCaseUrl = caseUrl ?? previous.caseUrl;
  return {
    status,
    updatedAt: now,
    pendingSince,
    ...(savedCaseUrl === undefined ? {} : { caseUrl: savedCaseUrl }),
  };
}

function metadataKey(slot: string): string {
  return `googleSetup:${connectionSlot(slot)}`;
}

export async function readGoogleSetup(ownerDid: string, slot = currentConnectionSlot('google', ownerDid)): Promise<GoogleSetupState> {
  const [identity] = await db.select({ metadata: identities.metadata }).from(identities)
    .where(eq(identities.id, ownerDid)).limit(1);
  return decodeGoogleSetup(object(identity?.metadata)[metadataKey(slot)]);
}

/** Row locking prevents simultaneous step edits from discarding other steps or slots. */
export function updateGoogleSetup(
  ownerDid: string,
  slot: string,
  stepId: GoogleSetupStepId,
  status: GoogleSetupStepState['status'],
  caseUrl?: string,
): Promise<GoogleSetupState> {
  const key = metadataKey(slot);
  return db.transaction(async (tx) => {
    const [identity] = await tx.select({ metadata: identities.metadata }).from(identities)
      .where(eq(identities.id, ownerDid)).for('update');
    if (!identity) throw new Error('google_setup_identity_missing');
    const state = decodeGoogleSetup(object(identity.metadata)[key]);
    state.steps[stepId] = nextGoogleSetupStep(state.steps[stepId], status, new Date().toISOString(), caseUrl);
    await tx.update(identities).set({
      metadata: sql`jsonb_set(coalesce(${identities.metadata}, '{}'::jsonb), ARRAY[${key}]::text[], ${JSON.stringify(state)}::jsonb, true)`,
      updatedAt: new Date(),
    }).where(eq(identities.id, ownerDid));
    return state;
  });
}


export async function requireBusinessProfileApproval(ownerDid: string, slot = currentConnectionSlot('google', ownerDid)): Promise<void> {
  const state = await readGoogleSetup(ownerDid, slot);
  if (state.steps['business-access'].status !== 'approved') {
    throw new Error('google_business_profile_approval_pending');
  }
}

/** A replacement client may belong to a different project; old project approval cannot carry over. */
export async function resetBusinessProfileApproval(ownerDid: string, slot = currentConnectionSlot('google', ownerDid)): Promise<void> {
  const state = await readGoogleSetup(ownerDid, slot);
  if (state.steps['business-access'].status === 'approved') {
    await updateGoogleSetup(ownerDid, slot, 'business-access', 'not_started');
  }
}
