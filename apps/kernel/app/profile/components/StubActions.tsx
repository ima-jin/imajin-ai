'use client';

interface StubActionsProps {
  identityDid: string;
  profileHandle?: string;
  claimStatus?: string | null;
  isMaintainer: boolean;
  viewerDid: string | null;
}

export function StubActions({
  identityDid,
  profileHandle,
  claimStatus,
  isMaintainer,
  viewerDid,
}: StubActionsProps) {
  const isUnclaimed = !claimStatus || claimStatus === 'unclaimed';

  if (!isUnclaimed && !isMaintainer) return null;

  const encodedDid = encodeURIComponent(identityDid);

  return (
    <div className="mb-6 bg-sky-950/30 border border-sky-800/40 px-4 py-3 text-sm text-sky-300">
      {isMaintainer ? (
        <div>
          <p className="text-xs text-sky-500 text-center">
            ✓ You are a maintainer of this place.
          </p>
          <div className="mt-3 text-center">
            <a
              href={`/auth/stubs/${encodedDid}`}
              className="text-xs text-sky-400 hover:text-sky-300 hover:underline"
            >
              ✏️ Edit this place
            </a>
          </div>
        </div>
      ) : (
        isUnclaimed && viewerDid && (
          <div className="space-y-2">
            <p className="text-center text-sky-300 text-xs">
              This place is community-maintained.
            </p>
            <div className="flex flex-col items-center gap-2 mt-2">
              <form
                action={`/profile/api/stubs/${encodeURIComponent(identityDid)}/join`}
                method="POST"
              >
                <button
                  type="submit"
                  className="px-4 py-1.5 bg-sky-700 hover:bg-sky-600 text-primary text-xs font-medium transition-colors"
                >
                  Help maintain this place
                </button>
              </form>
              {profileHandle && (
                <a
                  href={`/claim/${encodeURIComponent(profileHandle)}`}
                  className="text-xs text-sky-400 hover:text-sky-300 hover:underline"
                >
                  Claim this business
                </a>
              )}
            </div>
          </div>
        )
      )}

      <div className="mt-3 text-center">
        <button
          type="button"
          disabled
          className="text-xs text-muted cursor-not-allowed"
          title="Coming soon"
        >
          ✏️ Suggest an edit
        </button>
      </div>
    </div>
  );
}
