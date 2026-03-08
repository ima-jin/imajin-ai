import { NextRequest, NextResponse } from 'next/server';
import { db, bugReports } from '@/db';
import { eq } from 'drizzle-orm';
import { authenticateRequest, isAdmin } from '@/lib/session-auth';

const GITHUB_REPO = process.env.GITHUB_REPO || 'ima-jin/imajin-ai';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// POST /api/bugs/[id]/import — create a GitHub issue from a bug report (admin only)
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await authenticateRequest(request);
  if (!auth.authenticated || !auth.identity) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!isAdmin(auth.identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (!GITHUB_TOKEN) {
    return NextResponse.json({ error: 'GITHUB_TOKEN not configured' }, { status: 500 });
  }

  const [report] = await db.select().from(bugReports).where(eq(bugReports.id, params.id));
  if (!report) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const title = `[Bug Report] ${report.description.slice(0, 80)}`;

  const bodyParts: string[] = [report.description];

  if (report.screenshotUrl) {
    bodyParts.push(`\n## Screenshot\n![Screenshot](${report.screenshotUrl})`);
  }

  const meta: string[] = [];
  if (report.pageUrl) meta.push(`**Page:** ${report.pageUrl}`);
  if (report.viewport) meta.push(`**Viewport:** ${report.viewport}`);
  if (report.userAgent) meta.push(`**User Agent:** \`${report.userAgent}\``);
  if (report.reporterDid) meta.push(`**Reporter:** ${report.reporterDid}`);
  if (report.reporterName) meta.push(`**Name:** ${report.reporterName}`);

  if (meta.length > 0) {
    bodyParts.push(`\n## Metadata\n${meta.join('\n')}`);
  }

  const issueBody = bodyParts.join('\n');

  const ghRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ title, body: issueBody, labels: ['bug'] }),
  });

  if (!ghRes.ok) {
    const error = await ghRes.text();
    console.error('GitHub API error:', error);
    return NextResponse.json({ error: 'Failed to create GitHub issue', details: error }, { status: 502 });
  }

  const issue = await ghRes.json() as { number: number; html_url: string };

  const [updated] = await db
    .update(bugReports)
    .set({
      status: 'imported',
      githubIssueNumber: issue.number,
      githubIssueUrl: issue.html_url,
      reviewedBy: auth.identity.did,
      reviewedAt: new Date(),
    })
    .where(eq(bugReports.id, params.id))
    .returning();

  return NextResponse.json(updated);
}
