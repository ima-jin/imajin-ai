/**
 * Bug-report → GitHub issue import (#2184).
 *
 * Thin wrapper over `./connector` so the bug-import route hits the same
 * OAuth2/App-install write path as every other GitHub write in the kernel:
 * `requireGrantAndToken()`'s fail-closed credential gate, then
 * `requireAppendGate()`'s confirm rail, then a `github.action_proposals`
 * row and `action.done`/`action.proposed` bus events. No second GitHub
 * client, no env-var token, no PAT fallback anywhere in this path (org
 * invariant: NOT-PAT — see module docs on `./connector`).
 *
 * `importBugAsIssue()` is the only entry point:
 *  1. loads the bug report by id;
 *  2. builds the issue title/body/label from the report, verbatim with the
 *     pre-#2184 route's formatting;
 *  3. submits through `createIssue()` on behalf of `actingDid` — the
 *     operator triaging the report.
 *
 * Connector-missing errors (`github_no_grant` / `github_no_credential` /
 * `github_credential_pending`, thrown by `requireGrantAndToken()`) are NOT
 * caught here — they propagate to the caller, which maps them to a
 * structured 409/412 via `bugImportConnectorErrorResponse()` below.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, bugReports, type BugReport } from '@/src/db';
import { createIssue } from './connector';

/**
 * The repo bug reports are imported into. Connector/config state, not an env
 * var (#2184): the connector already carries the per-DID auth surface (grant
 * + sealed credential), and this platform's own bug tracker always targets
 * its own repo, so there is nothing per-caller left to configure.
 */
export const BUG_TRACKER_REPO = 'ima-jin/imajin-ai';

/** Which tracker `tracker`/`externalRef`/`externalUrl` describe. Only one today. */
export const BUG_TRACKER_KIND = 'github' as const;

const TYPE_LABEL_MAP: Record<string, string> = {
  suggestion: 'Suggestion',
  question: 'Question',
  other: 'Feedback',
};

function issueTitle(report: Pick<BugReport, 'type' | 'description'>): string {
  const typeLabel = TYPE_LABEL_MAP[report.type] ?? 'Bug Report';
  return `[${typeLabel}] ${report.description.slice(0, 80)}`;
}

function issueLabels(report: Pick<BugReport, 'type'>): string[] {
  return [report.type === 'suggestion' ? 'enhancement' : 'bug'];
}

function issueBody(report: Readonly<BugReport>): string {
  const parts: string[] = [report.description];

  if (report.screenshotUrl) {
    parts.push(`\n## Screenshot\n![Screenshot](${report.screenshotUrl})`);
  }

  const meta: string[] = [];
  if (report.pageUrl) meta.push(`**Page:** ${report.pageUrl}`);
  if (report.viewport) meta.push(`**Viewport:** ${report.viewport}`);
  if (report.userAgent) meta.push(`**User Agent:** \`${report.userAgent}\``);
  if (report.reporterDid) meta.push(`**Reporter:** ${report.reporterDid}`);
  if (report.reporterName) meta.push(`**Name:** ${report.reporterName}`);
  if (meta.length > 0) parts.push(`\n## Metadata\n${meta.join('\n')}`);

  return parts.join('\n');
}

export type ImportBugResult =
  | {
      status: 'done';
      tracker: typeof BUG_TRACKER_KIND;
      externalRef: string;
      externalUrl: string;
      issueNumber: number;
    }
  | { status: 'pending'; proposalId: string; message: string }
  | { status: 'not_found' };

/**
 * Import bug report `bugId` as a GitHub issue on behalf of `actingDid` (the
 * operator triaging it, i.e. the admin calling the route).
 *
 * Throws whatever `createIssue()` / `requireGrantAndToken()` throws on a
 * missing grant or credential (`github_no_grant`, `github_no_credential`,
 * `github_credential_pending`) — callers must map those via
 * `bugImportConnectorErrorResponse()`.
 */
export async function importBugAsIssue(
  bugId: string,
  actingDid: string,
): Promise<ImportBugResult> {
  const [report] = await db.select().from(bugReports).where(eq(bugReports.id, bugId));
  if (!report) return { status: 'not_found' };

  const result = await createIssue(
    actingDid,
    BUG_TRACKER_REPO,
    issueTitle(report),
    issueBody(report),
    issueLabels(report),
  );

  if (result.status === 'pending') {
    return { status: 'pending', proposalId: result.proposalId, message: result.message };
  }

  return {
    status: 'done',
    tracker: BUG_TRACKER_KIND,
    externalRef: `${BUG_TRACKER_REPO}#${result.data.number}`,
    externalUrl: result.data.html_url,
    issueNumber: result.data.number,
  };
}

/**
 * Translate a connector-missing failure from `importBugAsIssue()` into a
 * structured JSON response, or return `null` when `err` is not one of those
 * recognized cases (the caller should fall back to a generic 500).
 *
 * Both codes below satisfy the org invariant that a missing connector is
 * never silently retried against a PAT/env fallback — the caller is always
 * told explicitly to go enable the GitHub connector:
 *  - 412 (Precondition Failed) — no `github:write` grant at all; the scope
 *    itself was never enabled for this DID.
 *  - 409 (Conflict) — the grant exists but there is no usable credential yet
 *    (never connected, or a PAT sealed but still awaiting delegation
 *    approval) — the state that stands in the way is resolvable, not fatal.
 */
export function bugImportConnectorErrorResponse(err: unknown): NextResponse | null {
  const message = err instanceof Error ? err.message : String(err);

  if (message.startsWith('github_no_grant')) {
    return NextResponse.json(
      {
        error: 'github_connector_not_enabled',
        detail:
          'No active github:write grant for this account — enable the GitHub connector ' +
          '(scope-manifest) before importing bug reports as issues.',
      },
      { status: 412 },
    );
  }

  if (message.startsWith('github_no_credential')) {
    return NextResponse.json(
      {
        error: 'github_connector_not_connected',
        detail:
          'The GitHub connector scope is enabled but no credential is connected yet — ' +
          'connect it via /github/api/connect (OAuth) before importing bug reports as issues.',
      },
      { status: 409 },
    );
  }

  if (message.startsWith('github_credential_pending')) {
    return NextResponse.json(
      {
        error: 'github_connector_pending',
        detail:
          'A GitHub credential is sealed for this account but is still awaiting owner grant ' +
          'approval — approve the pending delegation before importing bug reports as issues.',
      },
      { status: 409 },
    );
  }

  return null;
}
