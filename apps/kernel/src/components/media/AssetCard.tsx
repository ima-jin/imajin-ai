"use client";

import React from "react";
import type { Asset } from "@/src/db/schema";
import { useLongPress } from "./useLongPress";

interface AssetCardProps {
  asset: Asset;
  selected: boolean;
  checked: boolean;
  compact?: boolean;
  selectionActive?: boolean;
  onSelect: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onCheck: (e: React.MouseEvent | React.KeyboardEvent) => void;
  onLongPress?: () => void;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getMimeIcon(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType.startsWith("audio/")) return "🎵";
  if (mimeType.startsWith("video/")) return "🎬";
  if (mimeType === "application/pdf") return "📄";
  if (mimeType.startsWith("text/")) return "📝";
  return "📎";
}

export function getFairAccess(fairManifest: unknown): string | null {
  if (!fairManifest || typeof fairManifest !== "object") return null;
  const m = fairManifest as Record<string, unknown>;
  if (Object.keys(m).length === 0) return null;
  const access = m.access;
  if (!access) return null;
  if (typeof access === "string") return access;
  if (typeof access === "object" && access !== null) {
    const t = (access as Record<string, unknown>).type;
    return typeof t === "string" ? t : null;
  }
  return null;
}

export function FairBadge({ access }: Readonly<{ access: string }>) {
  if (access === "public") {
    return (
      <span className="text-xs font-medium bg-green-500/15 text-green-400 px-1.5 py-0.5 rounded">
        .fair
      </span>
    );
  }
  if (access === "trust-graph") {
    return (
      <span className="text-xs font-medium bg-orange-500/15 text-orange-400 px-1.5 py-0.5 rounded">
        .fair
      </span>
    );
  }
  return (
    <span className="text-xs font-medium bg-red-500/15 text-red-400 px-1.5 py-0.5 rounded">
      .fair
    </span>
  );
}

function AssetCard({ asset, selected, checked, compact, selectionActive, onSelect, onCheck, onLongPress }: Readonly<AssetCardProps>) {
  const isImage = asset.mimeType.startsWith("image/");
  const fairAccess = getFairAccess(asset.fairManifest);
  const longPress = useLongPress(() => {
    onLongPress?.();
  }, 400);

  return (
    <div
      className={`group relative bg-[#252525] rounded-xl overflow-hidden cursor-pointer border-2 transition-all duration-150 ${
        selected || checked
          ? "border-orange-500 shadow-lg shadow-orange-500/20"
          : selectionActive
          ? "border-transparent hover:border-gray-500 opacity-90 hover:opacity-100"
          : "border-transparent hover:border-gray-600"
      }`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(e);
        }
      }}
      role="button"
      tabIndex={0}
      aria-label={`Select asset ${asset.filename}`}
      {...longPress}
    >
      {/* Checkbox overlay */}
      <button
        type="button"
        className={`absolute top-0.5 left-0.5 z-10 transition-opacity ${
          checked || selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        onClick={onCheck}
        aria-label={checked ? `Deselect asset ${asset.filename}` : `Select asset ${asset.filename}`}
      >
        <div className="flex items-center justify-center min-w-[44px] min-h-[44px]">
          <div
            className={`w-5 h-5 rounded border-2 flex items-center justify-center text-[10px] font-bold transition-colors ${
              checked
                ? "bg-orange-500 border-orange-500 text-white"
                : "bg-black/60 border-gray-400 text-transparent"
            }`}
          >
            ✓
          </div>
        </div>
      </button>

      {/* Thumbnail */}
      <div className="aspect-square bg-[#1a1a1a] flex items-center justify-center overflow-hidden">
        {isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/media/api/assets/${asset.id}?w=${compact ? 100 : 200}`}
            alt={asset.filename}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : (
          <span className={compact ? "text-2xl" : "text-4xl"}>{getMimeIcon(asset.mimeType)}</span>
        )}
      </div>

      {/* Info */}
      <div className={compact ? "p-1" : "p-2"}>
        <p
          className={`${compact ? "text-[10px]" : "text-xs"} text-gray-200 truncate font-medium`}
          title={asset.filename}
        >
          {asset.filename}
        </p>
        {compact ? (
          fairAccess !== null && (
            <div className="mt-0.5">
              <FairBadge access={fairAccess} />
            </div>
          )
        ) : (
          <div className="flex items-center justify-between mt-0.5">
            <span className="text-xs text-gray-500">{formatSize(asset.size)}</span>
            {fairAccess !== null && <FairBadge access={fairAccess} />}
          </div>
        )}
      </div>
    </div>
  );
}

const MemoAssetCard = React.memo(AssetCard, (prev, next) => {
  return prev.asset.id === next.asset.id
    && prev.selected === next.selected
    && prev.checked === next.checked
    && prev.selectionActive === next.selectionActive
    && prev.compact === next.compact
    && prev.onLongPress === next.onLongPress;
});

export { MemoAssetCard as AssetCard };
export default MemoAssetCard;
