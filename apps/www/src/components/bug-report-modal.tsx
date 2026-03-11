'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

const MEDIA_SERVICE_URL = process.env.NEXT_PUBLIC_MEDIA_SERVICE_URL || '';

interface Props {
  onClose: () => void;
}

type Status = 'idle' | 'uploading' | 'submitting' | 'success' | 'error';

const REPORT_TYPES = [
  { value: 'bug', label: '🐛 Bug', placeholder: 'What happened? What did you expect?' },
  { value: 'suggestion', label: '💡 Suggestion', placeholder: 'What would you like to see improved?' },
  { value: 'question', label: '❓ Question', placeholder: 'What are you wondering about?' },
  { value: 'other', label: '💬 Other', placeholder: 'Tell us what\'s on your mind.' },
] as const;

export function BugReportModal({ onClose }: Props) {
  const router = useRouter();
  const [type, setType] = useState<string>('bug');
  const [description, setDescription] = useState('');
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File | null) => {
    if (!file || !file.type.startsWith('image/')) return;
    setScreenshotFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0] ?? null;
    handleFile(file);
  }, []);

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = () => setDragging(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!description.trim()) return;

    setStatus('idle');
    setErrorMsg('');

    let screenshotUrl: string | undefined;

    if (screenshotFile) {
      setStatus('uploading');
      try {
        const formData = new FormData();
        formData.append('file', screenshotFile);
        const res = await fetch(`${MEDIA_SERVICE_URL}/api/assets`, {
          method: 'POST',
          body: formData,
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
        const data = await res.json() as { url?: string; src?: string };
        screenshotUrl = data.url ?? data.src;
      } catch (err) {
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : 'Screenshot upload failed');
        return;
      }
    }

    setStatus('submitting');
    try {
      const res = await fetch('/api/bugs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          description: description.trim(),
          screenshotUrl,
          pageUrl: window.location.href,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
        }),
      });
      if (!res.ok) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error || `Failed: ${res.status}`);
      }
      setStatus('success');
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Submission failed');
    }
  };

  const busy = status === 'uploading' || status === 'submitting';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-xl bg-[#111] border border-gray-800 shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-gray-100">Submit Feedback</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 transition-colors text-xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {status === 'success' ? (
          <div className="px-6 py-10 text-center">
            <p className="text-2xl mb-3">✓</p>
            <p className="text-gray-300 font-medium">Report submitted. Thanks!</p>
            <button
              onClick={() => { router.refresh(); onClose(); }}
              className="mt-6 px-4 py-2 rounded-lg bg-orange-500 hover:bg-orange-400 text-white text-sm transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
            {/* Report Type */}
            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="bug-type">
                Type
              </label>
              <select
                id="bug-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
                disabled={busy}
                className="w-full rounded-lg bg-[#1a1a1a] border border-gray-700 text-gray-100 px-3 py-2 text-sm focus:outline-none focus:border-orange-500 disabled:opacity-50"
              >
                {REPORT_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="bug-description">
                Description <span className="text-orange-500">*</span>
              </label>
              <textarea
                id="bug-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={REPORT_TYPES.find(t => t.value === type)?.placeholder ?? 'What happened?'}
                rows={5}
                required
                disabled={busy}
                className="w-full rounded-lg bg-[#1a1a1a] border border-gray-700 text-gray-100 placeholder-gray-600 px-3 py-2 text-sm focus:outline-none focus:border-orange-500 resize-none disabled:opacity-50"
              />
            </div>

            {/* Screenshot drop zone */}
            <div>
              <label className="block text-sm text-gray-400 mb-1">
                Screenshot <span className="text-gray-600">(optional)</span>
              </label>
              <div
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onClick={() => !busy && fileInputRef.current?.click()}
                className={`relative flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors ${
                  dragging
                    ? 'border-orange-500 bg-orange-500/10'
                    : 'border-gray-700 bg-[#1a1a1a] hover:border-gray-500'
                } ${busy ? 'pointer-events-none opacity-50' : ''}`}
              >
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt="Screenshot preview"
                    className="max-h-32 max-w-full rounded object-contain"
                  />
                ) : (
                  <p className="text-sm text-gray-500">
                    Drag & drop an image, or <span className="text-orange-400">click to browse</span>
                  </p>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="sr-only"
                  onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                  disabled={busy}
                />
              </div>
              {screenshotFile && (
                <p className="mt-1 text-xs text-gray-500">{screenshotFile.name}</p>
              )}
            </div>

            {errorMsg && (
              <p className="text-sm text-red-400">{errorMsg}</p>
            )}

            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !description.trim()}
                className="px-5 py-2 rounded-lg bg-orange-500 hover:bg-orange-400 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === 'uploading'
                  ? 'Uploading...'
                  : status === 'submitting'
                  ? 'Submitting...'
                  : 'Submit'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
