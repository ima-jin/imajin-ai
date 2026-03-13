"use client";

import { useState } from "react";
import type { Asset } from "@/src/db/schema";
import { FairEditor } from "@imajin/fair";
import type { FairManifest } from "@imajin/fair";
import { formatSize } from "./AssetCard";

interface Folder {
  id: string;
  name: string;
  icon: string | null;
}

interface AssetDetailProps {
  asset: Asset;
  folders: Folder[];
  onClose: () => void;
  onDeleted: () => void;
  onMoved: () => void;
}

function formatDate(d: Date | string | null): string {
  if (!d) return "Unknown";
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function AssetDetail({ asset, folders, onClose, onDeleted, onMoved }: AssetDetailProps) {
  const [editingFair, setEditingFair] = useState(false);
  const [fairManifest, setFairManifest] = useState<FairManifest | null>(() => {
    const m = asset.fairManifest;
    if (m && typeof m === "object" && Object.keys(m as object).length > 0) {
      return m as FairManifest;
    }
    return null;
  });
  const [movingTo, setMovingTo] = useState(false);
  const [shareLabel, setShareLabel] = useState("Copy URL");

  const isImage = asset.mimeType.startsWith("image/");
  const isAudio = asset.mimeType.startsWith("audio/");
  const isVideo = asset.mimeType.startsWith("video/");

  const assetUrl = `/api/assets/${asset.id}`;

  const handleDelete = async () => {
    if (!confirm(`Delete "${asset.filename}"? This cannot be undone.`)) return;
    await fetch(`/api/assets/${asset.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    onDeleted();
  };

  const handleShare = () => {
    const url = `${window.location.origin}/api/assets/${asset.id}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setShareLabel("Copied!");
    setTimeout(() => setShareLabel("Copy URL"), 2000);
  };

  const handleSaveFair = async (manifest: FairManifest) => {
    setFairManifest(manifest);
    // Save to backend — PUT /api/assets/{id}/fair (extension endpoint)
    await fetch(`/api/assets/${asset.id}/fair`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    }).catch(() => {});
  };

  const handleMove = async (folderId: string) => {
    await fetch(`/api/assets/${asset.id}/folders`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderIds: [folderId] }),
    });
    setMovingTo(false);
    onMoved();
  };

  const currentFolder = folders.find((f) => f.id === asset.folderId);
  const metadata = asset.metadata as Record<string, unknown> | null;
  const exif = metadata?.exif as Record<string, unknown> | undefined;

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Preview panel */}
      <div className="flex-1 flex flex-col overflow-hidden border-r border-gray-800 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 bg-[#1a1a1a] shrink-0">
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-sm shrink-0"
          >
            ← Back
          </button>
          <span className="text-gray-700">/</span>
          <span className="text-sm text-gray-200 truncate flex-1 min-w-0">{asset.filename}</span>
        </div>

        {/* Preview */}
        <div className="flex-1 flex items-center justify-center bg-[#111] overflow-hidden">
          {isImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={assetUrl}
              alt={asset.filename}
              className="max-w-full max-h-full object-contain"
            />
          )}
          {isAudio && (
            <div className="text-center space-y-4 p-8 w-full max-w-sm">
              <span className="text-8xl block">🎵</span>
              <p className="text-gray-300 text-sm truncate">{asset.filename}</p>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <audio controls className="w-full" style={{ colorScheme: "dark" }}>
                <source src={assetUrl} type={asset.mimeType} />
              </audio>
            </div>
          )}
          {isVideo && (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <video
              controls
              className="max-w-full max-h-full"
              style={{ colorScheme: "dark" }}
            >
              <source src={assetUrl} type={asset.mimeType} />
            </video>
          )}
          {!isImage && !isAudio && !isVideo && (
            <div className="text-center space-y-4">
              <span className="text-8xl block">📄</span>
              <p className="text-gray-300 text-sm">{asset.filename}</p>
              <a
                href={`${assetUrl}?download=true`}
                className="inline-block px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white text-sm rounded-lg transition-colors"
              >
                Download
              </a>
            </div>
          )}
        </div>

        {/* File info + actions */}
        <div className="px-4 py-3 border-t border-gray-800 bg-[#1a1a1a] shrink-0">
          <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400 mb-3">
            <span>{formatSize(asset.size)}</span>
            <span className="text-gray-700">·</span>
            <span>{asset.mimeType}</span>
            <span className="text-gray-700">·</span>
            <span>{formatDate(asset.createdAt)}</span>
            {currentFolder && (
              <>
                <span className="text-gray-700">·</span>
                <span>
                  {currentFolder.icon} {currentFolder.name}
                </span>
              </>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {movingTo ? (
              <>
                {folders.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => handleMove(f.id)}
                    className="text-xs px-2 py-1 bg-[#252525] border border-gray-700 rounded hover:border-orange-500 hover:text-orange-400 transition-colors text-gray-300"
                  >
                    {f.icon} {f.name}
                  </button>
                ))}
                <button
                  onClick={() => setMovingTo(false)}
                  className="text-xs px-2 py-1 text-gray-500 hover:text-gray-300"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleDelete}
                  className="px-3 py-1.5 text-xs bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg hover:bg-red-500/20 transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setMovingTo(true)}
                  className="px-3 py-1.5 text-xs bg-[#252525] border border-gray-700 text-gray-300 rounded-lg hover:border-gray-500 transition-colors"
                >
                  Move to…
                </button>
                <button
                  onClick={handleShare}
                  className="px-3 py-1.5 text-xs bg-[#252525] border border-gray-700 text-gray-300 rounded-lg hover:border-gray-500 transition-colors"
                >
                  {shareLabel}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Metadata sidebar */}
      <div className="w-72 shrink-0 overflow-y-auto bg-[#1a1a1a] border-l border-gray-800 p-4 space-y-4">
        {/* Classification */}
        {asset.classification && (
          <div className="bg-[#252525] rounded-xl p-3">
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Classification</p>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm text-gray-200 capitalize">{asset.classification}</span>
              {asset.classificationConfidence != null && (
                <span className="text-xs text-orange-400 font-mono">
                  {asset.classificationConfidence}%
                </span>
              )}
            </div>
            {asset.classificationConfidence != null && (
              <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-orange-500 rounded-full transition-all"
                  style={{ width: `${asset.classificationConfidence}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* EXIF data */}
        {exif && Object.keys(exif).length > 0 && (
          <div className="bg-[#252525] rounded-xl p-3">
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">EXIF</p>
            <div className="space-y-1.5">
              {Object.entries(exif)
                .slice(0, 10)
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 text-xs">
                    <span className="text-gray-500 capitalize shrink-0">
                      {k.replace(/([A-Z])/g, " $1").trim()}
                    </span>
                    <span className="text-gray-300 truncate text-right">{String(v)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* .fair manifest */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-gray-500 uppercase tracking-widest">.fair</p>
            {fairManifest && (
              <button
                onClick={() => setEditingFair(true)}
                className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
              >
                Edit ✏️
              </button>
            )}
          </div>

          {fairManifest ? (
            <FairEditor
              manifest={fairManifest}
              readOnly={true}
              sections={["attribution", "access", "transfer"]}
            />
          ) : (
            <div className="bg-[#252525] rounded-xl p-3 text-xs text-gray-500 italic">
              No .fair manifest.
            </div>
          )}
        </div>
      </div>

      {/* .fair edit modal */}
      {editingFair && fairManifest && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setEditingFair(false)}
        >
          <div
            className="bg-[#2a2a2a] border border-white/10 rounded-xl shadow-2xl p-4 w-[480px] max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-medium text-gray-200">Edit .fair Manifest</p>
              <button
                onClick={() => setEditingFair(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <FairEditor
              manifest={fairManifest}
              readOnly={false}
              onChange={handleSaveFair}
              sections={["attribution", "access", "transfer"]}
            />
            <div className="flex justify-end mt-3">
              <button
                onClick={() => setEditingFair(false)}
                className="px-3 py-1 text-sm bg-orange-500 text-white rounded-md hover:bg-orange-600 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
