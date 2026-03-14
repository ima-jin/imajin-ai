"use client";

import { useRef, useState, useCallback } from "react";
import type { Asset } from "@/src/db/schema";
import { AssetCard, formatSize, getMimeIcon } from "./AssetCard";
import { UploadZone, type UploadZoneHandle } from "./UploadZone";

interface AssetGridProps {
  assets: Asset[];
  loading: boolean;
  sort: string;
  order: string;
  typeFilter: string;
  selectedAssetId: string | null;
  onSortChange: (sort: string) => void;
  onOrderChange: (order: string) => void;
  onTypeFilterChange: (type: string) => void;
  onSelectAsset: (id: string) => void;
  onUploaded: () => void;
}

export function AssetGrid({
  assets,
  loading,
  sort,
  order,
  typeFilter,
  selectedAssetId,
  onSortChange,
  onOrderChange,
  onTypeFilterChange,
  onSelectAsset,
  onUploaded,
}: AssetGridProps) {
  const [dragging, setDragging] = useState(false);
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const uploadRef = useRef<UploadZoneHandle>(null);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current === 0) setDragging(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      // Trigger upload via a synthetic file input change using DataTransfer
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      // Create a temporary input and dispatch change
      const input = document.createElement("input");
      input.type = "file";
      input.files = dt.files;
      const event = new Event("change", { bubbles: true });
      Object.defineProperty(event, "target", { value: input });
      // We call openPicker which opens the real file input; instead, manually trigger via upload
      // Since UploadZone exposes openPicker only, we use a hidden form trick:
      // Upload directly from dropped files
      uploadDroppedFile(files[0]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const [dropUploading, setDropUploading] = useState(false);
  const [dropProgress, setDropProgress] = useState(0);
  const [dropSuggestion, setDropSuggestion] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);

  const uploadDroppedFile = useCallback(
    async (file: File) => {
      setDropUploading(true);
      setDropProgress(10);
      setDropSuggestion(null);
      setDropError(null);

      const formData = new FormData();
      formData.append("file", file);
      formData.append("filename", file.name);

      try {
        const res = await fetch("/api/assets", {
          method: "POST",
          credentials: "include",
          body: formData,
        });
        setDropProgress(90);
        if (res.ok) {
          const data = await res.json() as { classification?: { suggestedFolder?: string } };
          setDropProgress(100);
          if (data.classification?.suggestedFolder) {
            setDropSuggestion(data.classification.suggestedFolder);
          }
          onUploaded();
          setTimeout(() => {
            setDropUploading(false);
            setDropSuggestion(null);
          }, 3000);
        } else {
          const data = await res.json().catch(() => ({})) as { error?: string };
          setDropError(data.error ?? `Upload failed (${res.status})`);
          setDropUploading(false);
        }
      } catch {
        setDropError("Upload failed — network error");
        setDropUploading(false);
      }
    },
    [onUploaded]
  );

  return (
    <div
      className="flex flex-col h-full w-full relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-[#1a1a1a] shrink-0">
        <select
          value={typeFilter}
          onChange={(e) => onTypeFilterChange(e.target.value)}
          className="bg-[#252525] border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-orange-500"
        >
          <option value="">All types</option>
          <option value="image">Images</option>
          <option value="audio">Audio</option>
          <option value="video">Video</option>
          <option value="application">Documents</option>
        </select>

        <div className="flex-1" />

        <span className="text-xs text-gray-600">Sort:</span>
        {(["created", "name", "size"] as const).map((s) => (
          <button
            key={s}
            onClick={() => {
              if (sort === s) {
                onOrderChange(order === "asc" ? "desc" : "asc");
              } else {
                onSortChange(s);
                onOrderChange("desc");
              }
            }}
            className={`text-xs px-2 py-1 rounded transition-colors capitalize ${
              sort === s
                ? "bg-orange-500 text-white"
                : "text-gray-400 hover:text-gray-200 hover:bg-white/10"
            }`}
          >
            {s}
            {sort === s ? (order === "asc" ? " ↑" : " ↓") : ""}
          </button>
        ))}

        <button
          onClick={() => uploadRef.current?.openPicker()}
          className="ml-1 px-3 py-1 bg-orange-500 hover:bg-orange-600 text-white text-xs font-medium rounded-lg transition-colors"
        >
          + Upload
        </button>

        {/* View toggle */}
        <div className="flex items-center border border-gray-700 rounded overflow-hidden ml-1">
          <button
            onClick={() => setViewMode("grid")}
            className={`p-1.5 text-xs transition-colors ${viewMode === "grid" ? "bg-orange-500 text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/10"}`}
            title="Grid view"
            aria-label="Grid view"
          >
            ⊞
          </button>
          <button
            onClick={() => setViewMode("list")}
            className={`p-1.5 text-xs transition-colors ${viewMode === "list" ? "bg-orange-500 text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/10"}`}
            title="List view"
            aria-label="List view"
          >
            ☰
          </button>
        </div>
      </div>

      {/* Upload zone progress (from file picker) */}
      <UploadZone ref={uploadRef} onUploaded={onUploaded} />

      {/* Drop upload progress */}
      {dropUploading && (
        <div className="px-4 py-2 bg-[#1a1a1a] border-b border-gray-800 shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-orange-500 rounded-full transition-all duration-500"
                style={{ width: `${dropProgress}%` }}
              />
            </div>
            {dropSuggestion && (
              <span className="text-xs text-orange-400 whitespace-nowrap">
                Suggested: 📁 {dropSuggestion}
              </span>
            )}
          </div>
        </div>
      )}
      {dropError && (
        <div className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400 shrink-0 flex items-center justify-between">
          <span>{dropError}</span>
          <button onClick={() => setDropError(null)} className="hover:text-red-200 ml-2">
            ✕
          </button>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="bg-[#252525] rounded-xl overflow-hidden animate-pulse">
                <div className="aspect-square bg-[#2a2a2a]" />
                <div className="p-2 space-y-1">
                  <div className="h-2 bg-[#2a2a2a] rounded w-3/4" />
                  <div className="h-2 bg-[#2a2a2a] rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : assets.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center py-16 min-h-[300px]">
            <span className="text-6xl mb-4">📂</span>
            <p className="text-gray-400 text-lg font-medium mb-1">No files here</p>
            <p className="text-gray-600 text-sm mb-6">Drag and drop files to upload, or click + Upload</p>
            <button
              onClick={() => uploadRef.current?.openPicker()}
              className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm rounded-lg transition-colors"
            >
              Upload your first file
            </button>
          </div>
        ) : viewMode === "grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                selected={asset.id === selectedAssetId}
                onSelect={() => onSelectAsset(asset.id)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {assets.map((asset) => {
              const hasFair = !!(
                asset.fairManifest &&
                typeof asset.fairManifest === "object" &&
                Object.keys(asset.fairManifest as object).length > 0
              );
              const date = asset.createdAt
                ? new Date(asset.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : "—";
              return (
                <div
                  key={asset.id}
                  role="button"
                  tabIndex={0}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border transition-colors ${
                    asset.id === selectedAssetId
                      ? "border-orange-500 bg-orange-500/10"
                      : "border-transparent hover:bg-white/5"
                  }`}
                  onClick={() => onSelectAsset(asset.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectAsset(asset.id); } }}
                >
                  <span className="text-lg shrink-0">{getMimeIcon(asset.mimeType)}</span>
                  <span className="text-sm text-gray-200 flex-1 truncate min-w-0">{asset.filename}</span>
                  <span className="text-xs text-gray-500 shrink-0 w-16 text-right hidden sm:block">{formatSize(asset.size)}</span>
                  <span className="text-xs text-gray-600 shrink-0 w-16 hidden md:block">{asset.mimeType.split("/")[0]}</span>
                  <span className="text-xs text-gray-600 shrink-0 w-24 text-right hidden lg:block">{date}</span>
                  <span className="w-8 shrink-0 text-right">
                    {hasFair && <span className="text-xs text-green-400 font-medium">.fair</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Drag-over overlay */}
      {dragging && (
        <div className="absolute inset-0 bg-orange-500/10 border-2 border-dashed border-orange-500 rounded pointer-events-none z-10 flex items-center justify-center">
          <div className="text-center">
            <span className="text-5xl block mb-2">📤</span>
            <p className="text-orange-400 text-lg font-semibold">Drop to upload</p>
          </div>
        </div>
      )}
    </div>
  );
}
