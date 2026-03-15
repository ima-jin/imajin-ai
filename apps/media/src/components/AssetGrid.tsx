"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import type { Asset, Folder } from "@/src/db/schema";
import { AssetCard, formatSize, getMimeIcon, getFairAccess, FairBadge } from "./AssetCard";
import { UploadZone, type UploadZoneHandle } from "./UploadZone";

type ViewMode = "large-grid" | "small-grid" | "list";

interface AssetGridProps {
  assets: Asset[];
  loading: boolean;
  sort: string;
  order: string;
  typeFilter: string;
  selectedAssetId: string | null;
  folders?: Folder[];
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
  folders = [],
  onSortChange,
  onOrderChange,
  onTypeFilterChange,
  onSelectAsset,
  onUploaded,
}: AssetGridProps) {
  const [dragging, setDragging] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("large-grid");
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [moveFolderId, setMoveFolderId] = useState<string>("");
  const lastClickIdx = useRef<number | null>(null);
  const uploadRef = useRef<UploadZoneHandle>(null);
  const dragCounter = useRef(0);

  // Init viewMode from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    const stored = localStorage.getItem("imajin-media-view");
    if (stored === "small-grid" || stored === "list" || stored === "large-grid") {
      setViewMode(stored);
    }
  }, []);

  const handleSetViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem("imajin-media-view", mode);
  }, []);

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

  // Multi-select handlers
  const handleCardClick = useCallback(
    (e: React.MouseEvent, asset: Asset, idx: number) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        setSelectedAssetIds((prev) => {
          const next = new Set(prev);
          if (next.has(asset.id)) next.delete(asset.id);
          else next.add(asset.id);
          return next;
        });
        lastClickIdx.current = idx;
      } else if (e.shiftKey && lastClickIdx.current !== null) {
        e.preventDefault();
        const start = Math.min(lastClickIdx.current, idx);
        const end = Math.max(lastClickIdx.current, idx);
        setSelectedAssetIds(() => {
          const next = new Set<string>();
          for (let i = start; i <= end; i++) {
            next.add(assets[i].id);
          }
          return next;
        });
      } else {
        setSelectedAssetIds(new Set());
        lastClickIdx.current = idx;
        onSelectAsset(asset.id);
      }
    },
    [assets, onSelectAsset]
  );

  const handleCheckClick = useCallback((e: React.MouseEvent, assetId: string, idx: number) => {
    e.stopPropagation();
    setSelectedAssetIds((prev) => {
      const next = new Set(prev);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
    lastClickIdx.current = idx;
  }, []);

  const handleBatchDelete = useCallback(async () => {
    if (!window.confirm(`Delete ${selectedAssetIds.size} file(s)? This cannot be undone.`)) return;
    await Promise.all(
      Array.from(selectedAssetIds).map((id) =>
        fetch(`/api/assets/${id}`, { method: "DELETE", credentials: "include" })
      )
    );
    setSelectedAssetIds(new Set());
    onUploaded();
  }, [selectedAssetIds, onUploaded]);

  const handleBatchDownload = useCallback(() => {
    Array.from(selectedAssetIds).forEach((id) => {
      const a = document.createElement("a");
      a.href = `/api/assets/${id}`;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
  }, [selectedAssetIds]);

  const handleBatchMove = useCallback(async () => {
    if (!moveFolderId) return;
    await Promise.all(
      Array.from(selectedAssetIds).map((id) =>
        fetch(`/api/assets/${id}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folderId: moveFolderId }),
        })
      )
    );
    setSelectedAssetIds(new Set());
    setMoveFolderId("");
    onUploaded();
  }, [selectedAssetIds, moveFolderId, onUploaded]);

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

        {/* View toggle — large grid | small grid | list */}
        <div className="flex items-center border border-gray-700 rounded overflow-hidden ml-1">
          <button
            onClick={() => handleSetViewMode("large-grid")}
            className={`p-1.5 text-xs transition-colors ${viewMode === "large-grid" ? "bg-orange-500 text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/10"}`}
            title="Large grid"
            aria-label="Large grid view"
          >
            ⊞
          </button>
          <button
            onClick={() => handleSetViewMode("small-grid")}
            className={`p-1.5 text-xs transition-colors ${viewMode === "small-grid" ? "bg-orange-500 text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/10"}`}
            title="Small grid"
            aria-label="Small grid view"
          >
            ⊠
          </button>
          <button
            onClick={() => handleSetViewMode("list")}
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

      {/* Batch action bar — visible when >1 selected */}
      {selectedAssetIds.size > 1 && (
        <div className="flex items-center gap-2 px-4 py-2 bg-orange-500/10 border-b border-orange-500/30 shrink-0 flex-wrap">
          <span className="text-xs text-orange-400 font-medium">
            {selectedAssetIds.size} selected
          </span>
          <div className="flex-1" />
          <button
            onClick={handleBatchDownload}
            className="text-xs px-2.5 py-1 rounded bg-white/10 text-gray-300 hover:bg-white/20 transition-colors"
          >
            ↓ Download
          </button>
          {folders.length > 0 && (
            <div className="flex items-center gap-1">
              <select
                value={moveFolderId}
                onChange={(e) => setMoveFolderId(e.target.value)}
                className="bg-[#252525] border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-orange-500"
              >
                <option value="">Move to folder…</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              {moveFolderId && (
                <button
                  onClick={handleBatchMove}
                  className="text-xs px-2.5 py-1 rounded bg-white/10 text-gray-300 hover:bg-white/20 transition-colors"
                >
                  Move
                </button>
              )}
            </div>
          )}
          <button
            onClick={handleBatchDelete}
            className="text-xs px-2.5 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
          >
            Delete
          </button>
          <button
            onClick={() => setSelectedAssetIds(new Set())}
            className="text-xs px-2 py-1 rounded text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Content */}
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
        ) : viewMode === "large-grid" ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
            {assets.map((asset, idx) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                selected={asset.id === selectedAssetId}
                checked={selectedAssetIds.has(asset.id)}
                onSelect={(e) => handleCardClick(e, asset, idx)}
                onCheck={(e) => handleCheckClick(e, asset.id, idx)}
              />
            ))}
          </div>
        ) : viewMode === "small-grid" ? (
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 lg:grid-cols-10 gap-1.5">
            {assets.map((asset, idx) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                selected={asset.id === selectedAssetId}
                checked={selectedAssetIds.has(asset.id)}
                compact
                onSelect={(e) => handleCardClick(e, asset, idx)}
                onCheck={(e) => handleCheckClick(e, asset.id, idx)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {assets.map((asset, idx) => {
              const fairAccess = getFairAccess(asset.fairManifest);
              const date = asset.createdAt
                ? new Date(asset.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
                : "—";
              const isChecked = selectedAssetIds.has(asset.id);
              return (
                <div
                  key={asset.id}
                  role="button"
                  tabIndex={0}
                  className={`group flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer border transition-colors ${
                    asset.id === selectedAssetId || isChecked
                      ? "border-orange-500 bg-orange-500/10"
                      : "border-transparent hover:bg-white/5"
                  }`}
                  onClick={(e) => handleCardClick(e, asset, idx)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectAsset(asset.id);
                    }
                  }}
                >
                  {/* Checkbox */}
                  <div
                    className={`shrink-0 transition-opacity ${isChecked ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                    onClick={(e) => handleCheckClick(e, asset.id, idx)}
                  >
                    <div
                      className={`w-4 h-4 rounded border-2 flex items-center justify-center text-[9px] font-bold transition-colors ${
                        isChecked
                          ? "bg-orange-500 border-orange-500 text-white"
                          : "bg-black/60 border-gray-400 text-transparent"
                      }`}
                    >
                      ✓
                    </div>
                  </div>
                  <span className="text-lg shrink-0">{getMimeIcon(asset.mimeType)}</span>
                  <span className="text-sm text-gray-200 flex-1 truncate min-w-0">{asset.filename}</span>
                  <span className="text-xs text-gray-500 shrink-0 w-16 text-right hidden sm:block">{formatSize(asset.size)}</span>
                  <span className="text-xs text-gray-600 shrink-0 w-16 hidden md:block">{asset.mimeType.split("/")[0]}</span>
                  <span className="text-xs text-gray-600 shrink-0 w-24 text-right hidden lg:block">{date}</span>
                  <span className="w-10 shrink-0 text-right">
                    {fairAccess !== null && <FairBadge access={fairAccess} />}
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
