import { desc, eq } from 'drizzle-orm';
import { notify } from '@imajin/notify';
import { db, alphaSubmissions } from '@/src/db';
import { getOperatorDid } from '@/src/lib/notify/operator-approvals';
import type { AlphaIntent, AlphaSubmissionInput, AlphaSubmissionsPage } from './contract';

export async function storeAlphaSubmission(input: AlphaSubmissionInput): Promise<void> {
  await db.insert(alphaSubmissions).values(input);
  // The existing notification path is best-effort. Neither its payload nor
  // its logs get submission content, and there is no new email template.
  try {
    const operator = await getOperatorDid();
    if (operator) await notify.send({
      to: operator,
      scope: 'alpha.submitted',
      title: 'New alpha request',
      body: 'A new alpha request is available on /jin.',
      data: { url: '/jin#alpha-submissions' },
    });
  } catch {
    // The request is already durable; notification outages must not invite a duplicate.
  }
}

const PAGE_SIZE = 50;
export async function listAlphaSubmissions(intent: AlphaIntent | undefined, offset: number): Promise<AlphaSubmissionsPage> {
  const rows = await db.select().from(alphaSubmissions)
    .where(intent ? eq(alphaSubmissions.intent, intent) : undefined)
    .orderBy(desc(alphaSubmissions.createdAt), desc(alphaSubmissions.id))
    .limit(PAGE_SIZE + 1).offset(offset);
  return {
    submissions: rows.slice(0, PAGE_SIZE).map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
    hasMore: rows.length > PAGE_SIZE,
  };
}
