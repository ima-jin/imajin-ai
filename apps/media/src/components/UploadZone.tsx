"use client";

import { useRef, useState, useCallback, forwardRef, useImperativeHandle } from "react";

export interface UploadZoneHandle {
  openPicker: () => void;
}

interface UploadZoneProps {
  onUploaded: () => void;
  /** If true, renders only the trigger button (for use in headers). */
  buttonOnly?: boolean;
}

export const UploadZone = forwardRef<UploadZoneHandle, UploadZoneProps>(
  function UploadZone({ onUploaded, buttonOnly = false }, ref) {
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState(0);
    const [suggestion, setSuggestion] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useImperativeHandle(ref, () => ({
      openPicker: () => fileInputRef.current?.click(),
    }));

    const uploadFile = useCallback(
      async (file: File) => {
        setUploading(true);
        setProgress(10);
        setSuggestion(null);
        setError(null);

        const formData = new FormData();
        formData.append("file", file);

        try {
          const res = await fetch("/api/assets", {
            method: "POST",
            credentials: "include",
            body: formData,
          });

          setProgress(90);

          if (res.ok) {
            const data = await res.json();
            setProgress(100);
            const cls = (data as { classification?: { suggestedFolder?: string } }).classification;
            if (cls?.suggestedFolder) {
              setSuggestion(cls.suggestedFolder);
            }
            onUploaded();
            setTimeout(() => {
              setUploading(false);
              setSuggestion(null);
            }, 3000);
          } else {
            const data = await res.json().catch(() => ({})) as { error?: string };
            setError(data.error ?? `Upload failed (${res.status})`);
            setUploading(false);
          }
        } catch {
          setError("Upload failed — network error");
          setUploading(false);
        }
      },
      [onUploaded]
    );

    const handleFileChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files ?? []);
        if (files.length > 0) uploadFile(files[0]);
        e.target.value = "";
      },
      [uploadFile]
    );

    const input = (
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
        accept="image/*,audio/*,video/*,application/pdf,text/*"
      />
    );

    if (buttonOnly) {
      return (
        <>
          {input}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-orange-500 hover:bg-orange-600 disabled:opacity-60 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {uploading ? (
              <>
                <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Uploading…
              </>
            ) : (
              <>+ Upload</>
            )}
          </button>
        </>
      );
    }

    return (
      <>
        {input}
        {/* Progress + suggestion bar */}
        {uploading && (
          <div className="px-4 py-2 bg-[#1a1a1a] border-b border-gray-800 shrink-0">
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-orange-500 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              {suggestion && (
                <span className="text-xs text-orange-400 whitespace-nowrap">
                  Suggested: 📁 {suggestion}
                </span>
              )}
            </div>
          </div>
        )}
        {error && (
          <div className="px-4 py-1.5 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400 shrink-0 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="hover:text-red-200">✕</button>
          </div>
        )}
      </>
    );
  }
);
