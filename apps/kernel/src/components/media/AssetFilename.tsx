"use client";

import { useRef, useState } from "react";

/**
 * Inline rename affordance for an asset filename (#1543).
 *
 * The backend (`PATCH /media/api/assets/[id]`) is owner-only, refuses
 * immutable assets, and is deliberately *version-preserving* — it touches
 * `filename` + `storagePath` only, so `versionCount`, per-version CIDs and the
 * `.fair` chain are untouched. Nothing here should change that: this component
 * only surfaces the endpoint.
 *
 * The endpoint also carries an agent-approval gate (a delegated agent gets a
 * 403 with `AGENT_APPROVAL_REQUIRED`). We never suppress that — we surface it.
 */

export const EMPTY_FILENAME_ERROR = "Filename cannot be empty";
export const IMMUTABLE_RENAME_HINT = "Immutable asset — renaming is locked";

interface ErrorBody {
  error?: string;
  code?: string;
}

async function readErrorBody(res: Response): Promise<ErrorBody> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object") {
      const rec = body as Record<string, unknown>;
      return {
        error: typeof rec.error === "string" ? rec.error : undefined,
        code: typeof rec.code === "string" ? rec.code : undefined,
      };
    }
  } catch {
    // Non-JSON body — fall through to the status-based message.
  }
  return {};
}

/**
 * Maps a failed PATCH into copy a human can act on. The server's own `error`
 * string is preferred when it is already meaningful (e.g. the immutable
 * refusal); the bare `"Forbidden"` is not, so it gets rewritten.
 */
export async function renameErrorMessage(res: Response): Promise<string> {
  const { error, code } = await readErrorBody(res);

  if (code === "AGENT_APPROVAL_REQUIRED") {
    return "Renaming needs owner approval — agents cannot rename assets";
  }
  if (res.status === 400) {
    return error ?? EMPTY_FILENAME_ERROR;
  }
  if (res.status === 401) {
    return "Sign in again to rename this asset";
  }
  if (res.status === 403) {
    if (!error || error === "Forbidden") return "Only the owner can rename this asset";
    return error;
  }
  if (res.status === 404) {
    return "This asset no longer exists";
  }
  return error ?? "Rename failed";
}

interface AssetFilenameProps {
  assetId: string;
  filename: string;
  /** Current viewer owns the asset. Non-owners get no rename affordance. */
  isOwner: boolean;
  /** Immutable assets are locked server-side — no dead 403 path in the UI. */
  immutable: boolean;
  /** Called with the confirmed filename once the server accepts the rename. */
  onRenamed?: (filename: string) => void;
}

export function AssetFilename({
  assetId,
  filename,
  isOwner,
  immutable,
  onRenamed,
}: Readonly<AssetFilenameProps>) {
  const [name, setName] = useState(filename);
  const [draft, setDraft] = useState(filename);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);
  const committingRef = useRef(false);

  // The viewer swaps assets without remounting, so reset local state when the
  // asset behind us changes. Keyed off `assetId` only — reacting to `filename`
  // would clobber the optimistic name while the PATCH is still in flight.
  const [seenAssetId, setSeenAssetId] = useState(assetId);
  if (seenAssetId !== assetId) {
    setSeenAssetId(assetId);
    setName(filename);
    setDraft(filename);
    setEditing(false);
    setSaving(false);
    setError(null);
  }

  const canRename = isOwner && !immutable;

  const startEditing = () => {
    setDraft(name);
    setError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    cancelledRef.current = true;
    setEditing(false);
    setError(null);
  };

  const commit = async () => {
    // Enter commits and unmounts the input, which also fires blur — only the
    // first of the two should reach the network.
    if (committingRef.current) return;
    committingRef.current = true;
    try {
      const trimmed = draft.trim();
      if (!trimmed) {
        setError(EMPTY_FILENAME_ERROR);
        inputRef.current?.focus();
        return;
      }
      if (trimmed === name) {
        setEditing(false);
        setError(null);
        return;
      }

      const previous = name;
      setName(trimmed); // optimistic
      setEditing(false);
      setError(null);
      setSaving(true);

      let res: Response;
      try {
        res = await fetch(`/media/api/assets/${assetId}`, {
          method: "PATCH",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: trimmed }),
        });
      } catch {
        setName(previous);
        setError("Rename failed — check your connection and try again");
        return;
      }

      if (!res.ok) {
        setName(previous);
        setError(await renameErrorMessage(res));
        return;
      }

      const body = (await res.json().catch(() => null)) as { filename?: unknown } | null;
      const confirmed = typeof body?.filename === "string" ? body.filename : trimmed;
      setName(confirmed);
      onRenamed?.(confirmed);
    } finally {
      setSaving(false);
      committingRef.current = false;
    }
  };

  const handleBlur = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    commit();
  };

  const renderName = () => {
    if (editing) {
      return (
        <input
          ref={inputRef}
          className="flex-1 min-w-0 text-sm bg-[#252525] border border-orange-500 rounded px-1 py-0.5 text-gray-100 outline-none"
          value={draft}
          aria-label="Asset filename"
          aria-invalid={error !== null}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              cancelEditing();
            }
          }}
          onBlur={handleBlur}
          autoFocus
        />
      );
    }

    if (canRename) {
      return (
        <button
          type="button"
          className="text-sm text-gray-200 truncate flex-1 min-w-0 text-left cursor-pointer hover:text-white"
          onClick={startEditing}
          aria-label={`Rename ${name}`}
          title="Click to rename"
        >
          {name}
        </button>
      );
    }

    return (
      <span
        className="text-sm text-gray-200 truncate flex-1 min-w-0"
        title={isOwner && immutable ? IMMUTABLE_RENAME_HINT : name}
      >
        {name}
        {isOwner && immutable && (
          <span className="ml-1.5 text-gray-500" aria-label={IMMUTABLE_RENAME_HINT}>
            🔒
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {renderName()}
        {saving && <span className="text-xs text-gray-500 shrink-0">Renaming…</span>}
      </div>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
