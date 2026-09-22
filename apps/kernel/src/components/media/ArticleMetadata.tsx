"use client";

import { useState } from "react";
import type { Asset } from "@/src/db/schemas/media";
import { SLUG_REGEX, VALID_STATUSES, type ArticleStatus } from "@/src/lib/media/article-constants";

/**
 * "Has metadata" badge + editor for `metadata.article` (#1445).
 *
 * Frontmatter is the source of truth (#1193); `asset.metadata.article` is the
 * derived DB projection, kept in sync on every content write
 * (deriveArticleProjection, apps/kernel/src/lib/media/article-core.ts). This
 * component reads that projection rather than re-parsing the raw file, so the
 * badge and the edit form always agree with what the viewer otherwise shows.
 *
 * Saving goes through the existing PATCH /media/api/assets/[id]/article route
 * (routes/article.ts), which round-trips the edited fields through the
 * frontmatter codec (buildArticleBlock → composeArticleFile) server-side —
 * this component never builds YAML itself.
 */

export interface ArticleMetadataBlock {
  slug: string;
  title: string;
  subtitle?: string;
  description?: string;
  status: ArticleStatus;
  date: string;
  order?: number;
}

const FIELD_LABELS: ReadonlyArray<readonly [keyof ArticleMetadataBlock, string]> = [
  ["slug", "Slug"],
  ["title", "Title"],
  ["subtitle", "Subtitle"],
  ["description", "Description"],
  ["status", "Status"],
  ["date", "Date"],
  ["order", "Order"],
];

/** Read the derived `metadata.article` projection off an asset (#1193). */
export function readArticleMetadata(asset: Asset): ArticleMetadataBlock | null {
  const metadata = asset.metadata as Record<string, unknown> | null;
  const article = metadata?.article;
  if (!article || typeof article !== "object") return null;
  const block = article as Partial<ArticleMetadataBlock>;
  if (!block.slug || !block.title) return null;
  return block as ArticleMetadataBlock;
}

interface FormState {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  status: ArticleStatus;
  date: string;
  order: string;
}

function toFormState(block: ArticleMetadataBlock): FormState {
  return {
    slug: block.slug,
    title: block.title,
    subtitle: block.subtitle ?? "",
    description: block.description ?? "",
    status: block.status,
    date: block.date,
    order: block.order !== undefined ? String(block.order) : "",
  };
}

interface ArticleMetadataProps {
  asset: Asset;
  /** Current viewer owns the asset — same check the rest of the viewer uses (#1445). */
  isOwner: boolean;
  /** Fired with the server's updated asset after a successful save. */
  onSaved?: (asset: Asset) => void;
}

export function ArticleMetadata({ asset, isOwner, onSaved }: Readonly<ArticleMetadataProps>) {
  const article = readArticleMetadata(asset);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The viewer swaps assets in place (no remount) — drop any open edit state
  // for the asset we were previously showing.
  const [seenAssetId, setSeenAssetId] = useState(asset.id);
  if (seenAssetId !== asset.id) {
    setSeenAssetId(asset.id);
    setEditing(false);
    setForm(null);
    setError(null);
  }

  if (!article) return null;

  const startEditing = () => {
    setForm(toFormState(article));
    setError(null);
    setEditing(true);
    setExpanded(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setForm(null);
    setError(null);
  };

  const handleSave = async () => {
    if (!form) return;
    const slug = form.slug.trim();
    const title = form.title.trim();
    if (!SLUG_REGEX.test(slug)) {
      setError("Slug must be URL-safe (a-z, 0-9, hyphens only)");
      return;
    }
    if (!title) {
      setError("Title is required");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/media/api/assets/${asset.id}/article`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          title,
          subtitle: form.subtitle.trim() || undefined,
          description: form.description.trim() || undefined,
          status: form.status,
          date: form.date,
          order: form.order.trim() ? Number(form.order) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Save failed");
        return;
      }
      setEditing(false);
      setForm(null);
      onSaved?.(data as Asset);
    } catch {
      setError("Network error — check your connection and try again");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-[#252525] rounded-xl p-3">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1.5 text-xs text-gray-500 uppercase tracking-widest hover:text-gray-300 transition-colors"
          aria-expanded={expanded}
        >
          <span aria-hidden="true">📝</span>
          Has metadata
          <span className="text-[10px]" aria-hidden="true">{expanded ? "▲" : "▼"}</span>
        </button>
        {isOwner && !editing && (
          <button
            type="button"
            onClick={startEditing}
            className="text-xs text-orange-400 hover:text-orange-300 transition-colors"
          >
            Edit ✏️
          </button>
        )}
      </div>

      {expanded && !editing && (
        <dl className="mt-2 space-y-1.5">
          {FIELD_LABELS.filter(([key]) => {
            const value = article[key];
            return value !== undefined && value !== "";
          }).map(([key, label]) => (
            <div key={key} className="flex justify-between gap-2 text-xs">
              <dt className="text-gray-500 shrink-0">{label}</dt>
              <dd className="text-gray-300 truncate text-right">{String(article[key])}</dd>
            </div>
          ))}
        </dl>
      )}

      {editing && form && (
        <div className="mt-2 space-y-2">
          <label className="block">
            <span className="text-[10px] text-gray-500">Slug</span>
            <input
              type="text"
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-gray-500">Title</span>
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-gray-500">Subtitle</span>
            <input
              type="text"
              value={form.subtitle}
              onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
            />
          </label>
          <label className="block">
            <span className="text-[10px] text-gray-500">Description</span>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
            />
          </label>
          <div className="flex gap-2">
            <label className="flex-1 block">
              <span className="text-[10px] text-gray-500">Status</span>
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as ArticleStatus })}
                className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
              >
                {VALID_STATUSES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="flex-1 block">
              <span className="text-[10px] text-gray-500">Date</span>
              <input
                type="date"
                value={form.date}
                onChange={(e) => setForm({ ...form, date: e.target.value })}
                className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
              />
            </label>
            <label className="w-16 block">
              <span className="text-[10px] text-gray-500">Order</span>
              <input
                type="number"
                value={form.order}
                onChange={(e) => setForm({ ...form, order: e.target.value })}
                className="w-full bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 focus:outline-none focus:border-orange-500"
              />
            </label>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-400">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={cancelEditing}
              disabled={saving}
              className="px-3 py-1 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-1 text-xs bg-orange-500 hover:bg-orange-600 text-white rounded transition-colors disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
