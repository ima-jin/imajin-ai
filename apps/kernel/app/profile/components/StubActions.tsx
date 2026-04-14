'use client';

import { useState } from 'react';
import { ImageUpload } from './ImageUpload';

interface StubActionsProps {
  identityDid: string;
  profileHandle?: string;
  claimStatus?: string | null;
  isMaintainer: boolean;
  viewerDid: string | null;
  currentAvatar?: string;
  currentBanner?: string;
}

export function StubActions({
  identityDid,
  profileHandle,
  claimStatus,
  isMaintainer,
  viewerDid,
  currentAvatar,
  currentBanner,
}: StubActionsProps) {
  const [expandedSection, setExpandedSection] = useState<'avatar' | 'banner' | null>(null);
  const isUnclaimed = !claimStatus || claimStatus === 'unclaimed';

  if (!isUnclaimed && !isMaintainer) return null;

  const encodedDid = encodeURIComponent(identityDid);

  async function updateProfile(fields: { avatar?: string; banner?: string }) {
    await fetch(`/profile/api/stubs/${encodedDid}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    window.location.reload();
  }

  return (
    <div className="mb-6 bg-sky-950/30 border border-sky-800/40 rounded-xl px-4 py-3 text-sm text-sky-300">
      {isMaintainer ? (
        <div>
          <p className="text-xs text-sky-500 text-center">
            ✓ You are a maintainer of this place.
          </p>

          {/* Avatar upload */}
          <div className="mt-3 border-t border-sky-800/30 pt-3">
            {expandedSection !== 'avatar' ? (
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={() => setExpandedSection('avatar')}
                  className="text-xs text-sky-400 hover:text-sky-300 hover:underline"
                >
                  {currentAvatar ? '🖼 Change avatar' : '🖼 Add avatar'}
                </button>
              </div>
            ) : (
              <div>
                <ImageUpload
                  did={identityDid}
                  currentAvatar={currentAvatar}
                  uploadUrl="/media/api/assets"
                  fileFieldName="file"
                  extraFields={{
                    context: JSON.stringify({ app: 'profile', feature: 'avatar', access: 'public' }),
                  }}
                  showEmojiToggle={false}
                  label="Avatar"
                  onUploadComplete={(url) => updateProfile({ avatar: url })}
                />
                <div className="text-center mt-2">
                  <button
                    type="button"
                    onClick={() => setExpandedSection(null)}
                    className="text-xs text-gray-500 hover:text-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Banner upload */}
          <div className="mt-3 border-t border-sky-800/30 pt-3">
            {expandedSection !== 'banner' ? (
              <div className="flex items-center justify-center gap-3">
                {currentBanner && (
                  <div
                    className="w-full h-12 rounded bg-cover bg-center"
                    style={{ backgroundImage: `url(${currentBanner})` }}
                  />
                )}
                <button
                  type="button"
                  onClick={() => setExpandedSection('banner')}
                  className="text-xs text-sky-400 hover:text-sky-300 hover:underline whitespace-nowrap"
                >
                  {currentBanner ? '🖼 Change banner' : '🖼 Add banner'}
                </button>
              </div>
            ) : (
              <div>
                <ImageUpload
                  did={identityDid}
                  currentAvatar={currentBanner}
                  uploadUrl="/media/api/assets"
                  fileFieldName="file"
                  maxSize={1200}
                  extraFields={{
                    context: JSON.stringify({ app: 'profile', feature: 'banner', access: 'public' }),
                  }}
                  showEmojiToggle={false}
                  label="Banner"
                  previewMode="banner"
                  onUploadComplete={(url) => updateProfile({ banner: url })}
                />
                <div className="text-center mt-2">
                  <button
                    type="button"
                    onClick={() => setExpandedSection(null)}
                    className="text-xs text-gray-500 hover:text-gray-400"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
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
                  className="px-4 py-1.5 bg-sky-700 hover:bg-sky-600 text-white rounded-lg text-xs font-medium transition-colors"
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
          className="text-xs text-gray-600 cursor-not-allowed"
          title="Coming soon"
        >
          ✏️ Suggest an edit
        </button>
      </div>
    </div>
  );
}
