"use client";

import { useState } from "react";
import type { Asset } from "@/src/db/schema";
import { FairEditor } from "@imajin/fair";
import type { FairManifest } from "@imajin/fair";

const PROFILE_URL = process.env.NEXT_PUBLIC_SERVICE_PREFIX
  ? `${process.env.NEXT_PUBLIC_SERVICE_PREFIX}profile.${process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}`
  : 'https://profile.imajin.ai';

async function resolveProfile(did: string): Promise<{ name: string; avatar?: string }> {
  const res = await fetch(`${PROFILE_URL}/api/profile/${encodeURIComponent(did)}`, { credentials: 'include' });
  if (!res.ok) throw new Error('Profile not found');
  const data = await res.json();
  return { name: data.handle || data.name || did.slice(0, 16), avatar: data.avatar };
}
import { formatSize } from "./AssetCard";
import { FileEditor, isTextAsset } from "./FileEditor";

interface Folder {
  id: string;
  name: string;
  icon: string | null;
}

function FairEditModal({
  manifest,
  onSave,
  onCancel,
}: {
  manifest: FairManifest;
  onSave: (m: FairManifest) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<FairManifest>(manifest);
  const [saving, setSaving] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-surface-base/60"
      role="button"
      tabIndex={0}
      onClick={onCancel}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <div
        className="bg-[#2a2a2a] border border-white/10 p-4 w-[480px] max-h-[80vh] overflow-y-auto"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-medium text-primary">Edit .fair Manifest</p>
          <button
            onClick={onCancel}
            className="text-secondary hover:text-primary transition-colors"
          >
            ✕
          </button>
        </div>
        <FairEditor
          resolveProfile={resolveProfile}
          manifest={draft}
          readOnly={false}
          onChange={setDraft}
          sections={["attribution", "access", "transfer"]}
        />
        <div className="flex justify-end gap-2 mt-3">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm text-secondary hover:text-primary transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              await onSave(draft);
              setSaving(false);
              onCancel();
            }}
            style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="px-4 py-1.5 text-sm text-primary hover:brightness-110 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AssetDetailProps {
  asset: Asset;
  folders: Folder[];
  currentDid?: string;
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

export function AssetDetail({ asset, folders, currentDid, onClose, onDeleted, onMoved }: AssetDetailProps) {
  const isOwner = !!currentDid && currentDid === asset.ownerDid;
  const showFileEditor = isTextAsset(asset);
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
  const [savedFilename, setSavedFilename] = useState(asset.filename);
  const [editingFilename, setEditingFilename] = useState(false);
  const [filenameInput, setFilenameInput] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<Record<string, unknown> | null>(
    () => (asset.metadata as Record<string, unknown> | null)?.transcript as Record<string, unknown> | null ?? null
  );

  const isImage = asset.mimeType.startsWith("image/");
  const isAudio = asset.mimeType.startsWith("audio/");
  const isVideo = asset.mimeType.startsWith("video/");

  const assetUrl = `/media/api/assets/${asset.id}`;

  const handleDelete = async () => {
    if (!confirm(`Delete "${asset.filename}"? This cannot be undone.`)) return;
    await fetch(`/media/api/assets/${asset.id}`, {
      method: "DELETE",
      credentials: "include",
    });
    onDeleted();
  };

  const handleShare = () => {
    const url = `${window.location.origin}/media/api/assets/${asset.id}`;
    navigator.clipboard.writeText(url).catch(() => {});
    setShareLabel("Copied!");
    setTimeout(() => setShareLabel("Copy URL"), 2000);
  };

  const handleRenameFile = async () => {
    const trimmed = filenameInput.trim();
    if (!trimmed || trimmed === savedFilename) {
      setEditingFilename(false);
      return;
    }
    const res = await fetch(`/media/api/assets/${asset.id}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: trimmed }),
    });
    if (res.ok) {
      setSavedFilename(trimmed);
    }
    setEditingFilename(false);
  };

  const handleTranscribe = async () => {
    setTranscribing(true);
    try {
      const res = await fetch(`/media/api/assets/${asset.id}/transcribe`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = await res.json();
        setTranscript(data.transcript);
      }
    } finally {
      setTranscribing(false);
    }
  };

  const handleDownloadTranscript = () => {
    if (!transcript?.text) return;
    const baseName = savedFilename.replace(/\.[^.]+$/, "");
    const blob = new Blob([transcript.text as string], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${baseName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveFair = async (manifest: FairManifest) => {
    setFairManifest(manifest);
    // Save to backend — PUT /api/assets/{id}/fair (extension endpoint)
    await fetch(`/media/api/assets/${asset.id}/fair`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    }).catch(() => {});
  };

  const handleMove = async (folderId: string) => {
    await fetch(`/media/api/assets/${asset.id}/folders`, {
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
      <div className="flex-1 flex flex-col overflow-hidden border-r border-white/10 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-[#1a1a1a] shrink-0">
          <button
            onClick={onClose}
            className="text-secondary hover:text-primary transition-colors text-sm shrink-0"
          >
            ← Back
          </button>
          <span className="text-gray-700">/</span>
          {editingFilename ? (
            <input
              className="flex-1 min-w-0 text-sm bg-[#252525] border border-imajin-orange px-1 py-0.5 text-primary outline-none"
              value={filenameInput}
              onChange={(e) => setFilenameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameFile();
                if (e.key === "Escape") setEditingFilename(false);
              }}
              onBlur={handleRenameFile}
              autoFocus
            />
          ) : (
            <span
              className="text-sm text-primary truncate flex-1 min-w-0 cursor-pointer hover:text-primary"
              onClick={() => { setFilenameInput(savedFilename); setEditingFilename(true); }}
              title="Click to rename"
            >
              {savedFilename}
            </span>
          )}
        </div>

        {/* Preview */}
        <div className={`flex-1 overflow-hidden ${showFileEditor ? "flex" : "flex items-center justify-center bg-[#111]"}`}>
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
              <p className="text-primary text-sm truncate">{asset.filename}</p>
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
          {!isImage && !isAudio && !isVideo && showFileEditor && (
            <FileEditor asset={asset} isOwner={isOwner} />
          )}
          {!isImage && !isAudio && !isVideo && !showFileEditor && (
            <div className="text-center space-y-4">
              <span className="text-8xl block">📄</span>
              <p className="text-primary text-sm">{asset.filename}</p>
              <a
                href={`${assetUrl}?download=true`}
                style={{ background: 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)' }} className="inline-block px-4 py-2 hover:brightness-110 text-primary text-sm transition-colors"
              >
                Download
              </a>
            </div>
          )}
        </div>

        {/* File info + actions */}
        <div className="px-4 py-3 border-t border-white/10 bg-[#1a1a1a] shrink-0">
          <div className="flex flex-wrap items-center gap-3 text-xs text-secondary mb-3">
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
                    className="text-xs px-2 py-1 bg-[#252525] border border-white/10 hover:border-imajin-orange hover:text-imajin-orange transition-colors text-primary"
                  >
                    {f.icon} {f.name}
                  </button>
                ))}
                <button
                  onClick={() => setMovingTo(false)}
                  className="text-xs px-2 py-1 text-secondary hover:text-primary"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={handleDelete}
                  className="px-3 py-1.5 text-xs bg-error/10 border border-red-500/30 text-error hover:bg-error/20 transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setMovingTo(true)}
                  className="px-3 py-1.5 text-xs bg-[#252525] border border-white/10 text-primary hover:border-gray-500 transition-colors"
                >
                  Move to…
                </button>
                <button
                  onClick={handleShare}
                  className="px-3 py-1.5 text-xs bg-[#252525] border border-white/10 text-primary hover:border-gray-500 transition-colors"
                >
                  {shareLabel}
                </button>
                {(isAudio || isVideo) && (
                  <button
                    onClick={handleTranscribe}
                    disabled={transcribing}
                    className="px-3 py-1.5 text-xs bg-[#252525] border border-white/10 text-primary hover:border-gray-500 transition-colors disabled:opacity-50"
                  >
                    {transcribing ? "Transcribing…" : transcript ? "Re-transcribe" : "Transcribe"}
                  </button>
                )}
              </>
            )}
          </div>

          {transcript && (
            <div className="mt-3 p-3 bg-[#252525] space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-secondary uppercase tracking-widest">Transcript</p>
                <button
                  onClick={handleDownloadTranscript}
                  className="text-xs text-imajin-orange hover:text-imajin-orange/70 transition-colors"
                >
                  Download .txt
                </button>
              </div>
              <div className="flex gap-4 text-xs text-secondary">
                {transcript.language && (
                  <span>Language: {String(transcript.language).toUpperCase()}</span>
                )}
                {transcript.durationSeconds != null && (
                  <span>{Math.round(transcript.durationSeconds as number)}s</span>
                )}
              </div>
              <p className="text-sm text-primary whitespace-pre-wrap leading-relaxed">
                {transcript.text as string}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Metadata sidebar */}
      <div className="w-72 shrink-0 overflow-y-auto bg-[#1a1a1a] border-l border-white/10 p-4 space-y-4">
        {/* Classification */}
        {asset.classification && (
          <div className="bg-[#252525] p-3">
            <p className="text-xs text-secondary uppercase tracking-widest mb-2">Classification</p>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm text-primary capitalize">{asset.classification}</span>
              {asset.classificationConfidence != null && (
                <span className="text-xs text-imajin-orange font-mono">
                  {asset.classificationConfidence}%
                </span>
              )}
            </div>
            {asset.classificationConfidence != null && (
              <div className="h-1 bg-surface-elevated overflow-hidden">
                <div
                  className="h-full bg-imajin-orange transition-all"
                  style={{ width: `${asset.classificationConfidence}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* EXIF data */}
        {exif && Object.keys(exif).length > 0 && (
          <div className="bg-[#252525] p-3">
            <p className="text-xs text-secondary uppercase tracking-widest mb-2">EXIF</p>
            <div className="space-y-1.5">
              {Object.entries(exif)
                .slice(0, 10)
                .map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2 text-xs">
                    <span className="text-secondary capitalize shrink-0">
                      {k.replace(/([A-Z])/g, " $1").trim()}
                    </span>
                    <span className="text-primary truncate text-right">{String(v)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* .fair manifest */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs text-secondary uppercase tracking-widest">.fair</p>
            {fairManifest && (
              <button
                onClick={() => setEditingFair(true)}
                className="text-xs text-imajin-orange hover:text-imajin-orange/70 transition-colors"
              >
                Edit ✏️
              </button>
            )}
          </div>

          {fairManifest ? (
            <FairEditor resolveProfile={resolveProfile}
              manifest={fairManifest}
              readOnly={true}
              sections={["attribution", "access", "transfer"]}
            />
          ) : (
            <div className="bg-[#252525] p-3 text-xs text-secondary italic">
              No .fair manifest.
            </div>
          )}
        </div>
      </div>

      {/* .fair edit modal */}
      {editingFair && fairManifest && (
        <FairEditModal
          manifest={fairManifest}
          onSave={handleSaveFair}
          onCancel={() => setEditingFair(false)}
        />
      )}
    </div>
  );
}
