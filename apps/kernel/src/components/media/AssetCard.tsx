"use client";

import type { Asset } from "@/src/db/schema";

interface AssetCardProps {
  asset: Asset;
  selected: boolean;
  checked: boolean;
  compact?: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onCheck: (e: React.MouseEvent) => void;
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

export function FairBadge({ access }: { access: string }) {
  if (access === "public") {
    return (
      <span className="text-xs font-medium bg-success/15 text-success px-1.5 py-0.5 ">
        .fair
      </span>
    );
  }
  if (access === "trust-graph") {
    return (
      <span className="text-xs font-medium bg-imajin-orange/15 text-imajin-orange px-1.5 py-0.5 ">
        .fair
      </span>
    );
  }
  return (
    <span className="text-xs font-medium bg-error/15 text-error px-1.5 py-0.5 ">
      .fair
    </span>
  );
}

export function AssetCard({ asset, selected, checked, compact, onSelect, onCheck }: AssetCardProps) {
  const isImage = asset.mimeType.startsWith("image/");
  const fairAccess = getFairAccess(asset.fairManifest);

  return (
    <div
      className={`group relative bg-[#252525] overflow-hidden cursor-pointer border-2 transition-all duration-150 ${
        selected || checked
          ? "border-imajin-orange-orange-500/20"
          : "border-transparent hover:border-gray-600"
      }`}
      onClick={onSelect}
    >
      {/* Checkbox overlay */}
      <div
        className={`absolute top-1.5 left-1.5 z-10 transition-opacity ${
          checked ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        onClick={onCheck}
      >
        <div
          className={`w-5 h-5  border-2 flex items-center justify-center text-[10px] font-bold transition-colors ${
            checked
              ? "bg-imajin-orange border-imajin-orange text-primary"
              : "bg-surface-base/60 border-gray-400 text-transparent"
          }`}
        >
          ✓
        </div>
      </div>

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
          className={`${compact ? "text-[10px]" : "text-xs"} text-primary truncate font-medium`}
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
            <span className="text-xs text-secondary">{formatSize(asset.size)}</span>
            {fairAccess !== null && <FairBadge access={fairAccess} />}
          </div>
        )}
      </div>
    </div>
  );
}
