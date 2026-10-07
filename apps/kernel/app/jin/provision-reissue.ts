/**
 * Raise a claim-code reissue proposal from /jin (#2707).
 *
 * Reuses the EXISTING `POST /api/apps/provision` with `reissueClaim: true`
 * (#2411) — no new endpoint, no new authority. The route only ever stages a
 * `pending` `apps:provision` proposal; approving it on the operator-approvals
 * card is what issues a fresh one-time claim code, which the card then shows in
 * the amber `RevealedClaimCodeBanner`. Nothing returned here (or by the route's
 * 201/200 body) ever carries the code itself.
 */

export type ReissueResult =
  | { ok: true; proposalId: string; alreadyPending: boolean }
  | { ok: false; error: string };

interface ReissueResponseBody {
  status?: string;
  proposalId?: string;
  error?: string;
}

export async function proposeClaimReissue(params: { slug: string; displayName: string }): Promise<ReissueResult> {
  try {
    const res = await fetch('/api/apps/provision', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: params.slug, displayName: params.displayName, reissueClaim: true }),
    });
    const body = (await res.json().catch(() => ({}))) as ReissueResponseBody;
    if (!res.ok) {
      return { ok: false, error: body.error ?? `Failed to raise the reissue proposal (${res.status})` };
    }
    if (body.status === 'pending' && body.proposalId) {
      return { ok: true, proposalId: body.proposalId, alreadyPending: res.status === 200 };
    }
    return { ok: false, error: 'Unexpected response from apps.provision' };
  } catch {
    return { ok: false, error: 'Network error — the reissue proposal was not raised' };
  }
}
