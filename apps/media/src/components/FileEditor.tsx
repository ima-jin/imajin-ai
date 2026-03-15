"use client";

import { useState, useEffect, useCallback } from "react";
import type { Asset } from "@/src/db/schema";

// Lazily loaded — prismjs is side-effectful and large
let highlightCode: ((code: string, lang: "json" | "markdown" | "none") => string) | null = null;

async function getHighlighter() {
  if (highlightCode) return highlightCode;
  // Use main prismjs entry (has @types/prismjs declarations)
  const Prism = (await import("prismjs")).default;
  // Side-effect imports to register language grammars — no type declarations for subpaths
  /* eslint-disable */
  require("prismjs/components/prism-markup");
  require("prismjs/components/prism-json");
  require("prismjs/components/prism-markdown");
  /* eslint-enable */
  highlightCode = (code, lang) => {
    if (lang === "json" && Prism.languages.json) return Prism.highlight(code, Prism.languages.json, "json");
    if (lang === "markdown" && Prism.languages.markdown) return Prism.highlight(code, Prism.languages.markdown, "markdown");
    return code.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c));
  };
  return highlightCode;
}

function detectLang(filename: string): "json" | "markdown" | "none" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "none";
}

interface FileEditorProps {
  asset: Asset;
  isOwner: boolean;
}

export function FileEditor({ asset, isOwner }: FileEditorProps) {
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const [EditorComponent, setEditorComponent] = useState<React.ComponentType<{
    value: string;
    onValueChange: (v: string) => void;
    highlight: (code: string) => string;
    padding: number;
    style: React.CSSProperties;
    className?: string;
    readOnly?: boolean;
    tabSize?: number;
    insertSpaces?: boolean;
  }> | null>(null);
  const [ReactMarkdown, setReactMarkdown] = useState<React.ComponentType<{ children: string; className?: string }> | null>(null);
  const [highlighter, setHighlighter] = useState<typeof highlightCode>(null);

  const lang = detectLang(asset.filename);

  // Load editor and highlighter lazily
  useEffect(() => {
    Promise.all([
      import("react-simple-code-editor"),
      getHighlighter(),
      import("react-markdown"),
    ]).then(([editorMod, hl, mdMod]) => {
      setEditorComponent(() => editorMod.default as typeof EditorComponent);
      setHighlighter(() => hl);
      setReactMarkdown(() => mdMod.default as typeof ReactMarkdown);
    });
  }, []);

  // Fetch file content
  useEffect(() => {
    setLoading(true);
    setContent(null);
    fetch(`/api/assets/${asset.id}`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch(() => {
        setContent("");
        setLoading(false);
      });
  }, [asset.id]);

  const handleSave = useCallback(async () => {
    if (content === null) return;
    setSaving(true);
    setSaveStatus("idle");
    try {
      const res = await fetch(`/api/assets/${asset.id}/content`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      setSaveStatus(res.ok ? "saved" : "error");
    } catch {
      setSaveStatus("error");
    } finally {
      setSaving(false);
      setTimeout(() => setSaveStatus("idle"), 2500);
    }
  }, [asset.id, content]);

  // Keyboard shortcut: Ctrl/Cmd+S to save
  useEffect(() => {
    if (!isOwner) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOwner, handleSave]);

  const renderPreview = () => {
    if (content === null) return null;
    if (lang === "markdown" && ReactMarkdown) {
      return (
        <div className="flex-1 overflow-auto p-6">
          <div className="prose prose-invert prose-sm max-w-none text-gray-200 [&_h1]:text-orange-400 [&_h2]:text-orange-300 [&_h3]:text-gray-100 [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-zinc-900 [&_pre]:border [&_pre]:border-zinc-700 [&_blockquote]:border-l-orange-500 [&_a]:text-orange-400">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        </div>
      );
    }
    if (lang === "json") {
      let pretty = content;
      try {
        pretty = JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // leave as-is if not valid JSON
      }
      return (
        <div className="flex-1 overflow-auto p-4">
          <pre className="font-mono text-sm text-green-400 whitespace-pre-wrap break-words">{pretty}</pre>
        </div>
      );
    }
    // Plain text preview
    return (
      <div className="flex-1 overflow-auto p-4">
        <pre className="font-mono text-sm text-gray-200 whitespace-pre-wrap break-words">{content}</pre>
      </div>
    );
  };

  const highlightFn = useCallback(
    (code: string) => {
      if (!highlighter) return code;
      return highlighter(code, lang);
    },
    [highlighter, lang]
  );

  if (loading || !EditorComponent) {
    return (
      <div className="flex-1 flex items-center justify-center bg-zinc-900">
        <div className="text-gray-500 text-sm animate-pulse">Loading…</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden bg-zinc-900">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-800 bg-zinc-900 shrink-0">
        {/* Mode toggle */}
        <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
          <button
            onClick={() => setMode("edit")}
            className={`px-3 py-1 transition-colors ${
              mode === "edit"
                ? "bg-orange-500 text-white"
                : "bg-zinc-800 text-gray-400 hover:text-gray-200"
            } ${!isOwner ? "hidden" : ""}`}
          >
            Edit
          </button>
          <button
            onClick={() => setMode("preview")}
            className={`px-3 py-1 transition-colors ${
              mode === "preview"
                ? "bg-orange-500 text-white"
                : "bg-zinc-800 text-gray-400 hover:text-gray-200"
            }`}
          >
            Preview
          </button>
        </div>

        <span className="text-xs text-zinc-600 font-mono">{asset.filename}</span>

        <div className="flex-1" />

        {/* Save status */}
        {saveStatus === "saved" && (
          <span className="text-xs text-green-400">Saved</span>
        )}
        {saveStatus === "error" && (
          <span className="text-xs text-red-400">Save failed</span>
        )}

        {/* Save button — owner only, edit mode only */}
        {isOwner && mode === "edit" && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1 text-xs bg-orange-500 hover:bg-orange-600 text-white rounded transition-colors disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}

        {/* Read-only badge */}
        {!isOwner && (
          <span className="text-xs text-zinc-500 border border-zinc-700 rounded px-2 py-0.5">
            Read-only
          </span>
        )}
      </div>

      {/* Editor / Preview body */}
      {mode === "edit" && isOwner ? (
        <div className="flex-1 overflow-auto">
          <EditorComponent
            value={content ?? ""}
            onValueChange={setContent}
            highlight={highlightFn}
            padding={16}
            tabSize={2}
            insertSpaces
            className="min-h-full"
            style={{
              fontFamily: '"Fira Code", "Fira Mono", "Cascadia Code", "Consolas", monospace',
              fontSize: 13,
              lineHeight: 1.6,
              backgroundColor: "#18181b", // zinc-900
              color: "#e4e4e7", // zinc-200
              minHeight: "100%",
            }}
          />
        </div>
      ) : (
        renderPreview()
      )}
    </div>
  );
}

// Helper to detect if an asset is a text file that should use FileEditor
export function isTextAsset(asset: Asset): boolean {
  const { mimeType, filename } = asset;
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/yaml" ||
    mimeType === "application/x-yaml" ||
    mimeType === "application/toml"
  ) {
    return true;
  }
  // Fallback by extension for common text files
  const lower = filename.toLowerCase();
  return [".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".csv"].some((ext) =>
    lower.endsWith(ext)
  );
}
