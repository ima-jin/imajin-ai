"use client";

import type { Asset } from "@/src/db/schema";

interface AssetCardProps {
  asset: Asset;
  selected: boolean;
  onSelect: () => void;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getMimeIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType.startsWith("audio/")) return "🎵";
  if (mimeType.startsWith("video/")) return "🎬";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.startsWith("text/")) return "📝";
  return "📎";
}

export function AssetCard({ asset, selected, onSelect }: AssetCardProps) {
  const isImage = asset.mimeType.startsWith("image/");
  const hasFair =
    asset.fairManifest &&
    typeof asset.fairManifest === "object" &&
    Object.keys(asset.fairManifest as object).length > 0;

  return (
    <div
      className={`group relative bg-[#252525] rounded-xl overflow-hidden cursor-pointer border-2 transition-all duration-150 ${
        selected
          ? "border-orange-500 shadow-lg shadow-orange-500/20"
          : "border-transparent hover:border-gray-600"
      }`}
      onClick={onSelect}
    >
      {/* Thumbnail */}
      <div className="aspect-square bg-[#1a1a1a] flex items-center justify-center overflow-hidden">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/assets/${asset.id}?w=200`}
            alt={asset.filename}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className="text-4xl">{getMimeIcon(asset.mimeType)}</span>
        )}
      </div>

      {/* Info */}
      <div className="p-2">
        <p className="text-xs text-gray-200 truncate font-medium" title={asset.filename}>
          {asset.filename}
        </p>
        <div className="flex items-center justify-between mt-0.5">
          <span className="text-xs text-gray-500">{formatSize(asset.size)}</span>
          {hasFair ? (
            <span className="text-xs text-green-400" title=".fair manifest present">
              ✅
            </span>
          ) : (
            <span className="text-xs text-gray-600" title="No .fair manifest">
              ⚠️
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
