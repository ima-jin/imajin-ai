import { resolveActingDid, type Identity } from '@imajin/auth';

type ApprovalDid = { did: string } | { error: string; status: 400 | 403 };

/** Channel ownership is personal unless the authenticated caller explicitly opts in. */
export function resolveApprovalDid(identity: Identity, bindAs: unknown): ApprovalDid {
  if (bindAs === undefined || bindAs === 'self') return { did: identity.id };
  if (bindAs !== 'org') return { error: 'invalid bindAs', status: 400 };
  const did = resolveActingDid(identity);
  if (!identity.actingAs || did === identity.id || did !== identity.actingAs) {
    return { error: 'bindAs=org requires acting as an org', status: 403 };
  }
  return { did };
}
