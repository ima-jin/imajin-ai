import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, consentGrants } from '@/src/db';

export interface GrantSummary {
  purpose: string;
  fields: string[];
  activeContacts: number;
  revokedContacts: number;
  contacts: string[];
}

function isActive(status: string, expiresAt: Date | null): boolean {
  return status === 'active' && (expiresAt === null || expiresAt.getTime() > Date.now());
}

/**
 * GET /api/broker/grants — "what have I shared?" (#1053).
 *
 * Aggregates the acting subject's consent grants by purpose (data type),
 * unioning the released fields and counting active / revoked recipients.
 * Subjects only ever see their own grants (fail-closed).
 */
export async function getGrants(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const subject = resolveActingDid(auth.identity);

  const grants = await db
    .select()
    .from(consentGrants)
    .where(eq(consentGrants.subject, subject));

  interface Acc {
    fields: Set<string>;
    activeContacts: Set<string>;
    revokedContacts: Set<string>;
    contacts: Set<string>;
  }
  const byPurpose = new Map<string, Acc>();
  for (const g of grants) {
    let acc = byPurpose.get(g.purpose);
    if (!acc) {
      acc = { fields: new Set<string>(), activeContacts: new Set<string>(), revokedContacts: new Set<string>(), contacts: new Set<string>() };
      byPurpose.set(g.purpose, acc);
    }
    for (const f of g.allowedFields) acc.fields.add(f);
    const who = g.grantedTo ?? (g.grantedToClass ? `class:${g.grantedToClass}` : 'unknown');
    acc.contacts.add(who);
    if (g.status === 'revoked') acc.revokedContacts.add(who);
    else if (isActive(g.status, g.expiresAt)) acc.activeContacts.add(who);
  }

  const grantsOut: GrantSummary[] = [...byPurpose.entries()]
    .map(([purpose, acc]) => ({
      purpose,
      fields: [...acc.fields].sort((a, b) => a.localeCompare(b)),
      activeContacts: acc.activeContacts.size,
      revokedContacts: acc.revokedContacts.size,
      contacts: [...acc.contacts].sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.purpose.localeCompare(b.purpose));

  return NextResponse.json({ grants: grantsOut });
}
