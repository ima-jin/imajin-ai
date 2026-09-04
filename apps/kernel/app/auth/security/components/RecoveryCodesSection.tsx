'use client';

import { useState, useEffect } from 'react';

interface RecoveryCodeStatus {
  remaining: number;
  generatedAt: string | null;
}

/**
 * Recovery codes section of account security settings (#1250 Phase 1).
 * Self-contained: fetches its own status and owns its own generate/reveal
 * flow so it doesn't add to the parent page's branching complexity.
 */
export default function RecoveryCodesSection() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<RecoveryCodeStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disclosure, setDisclosure] = useState('');
  const [saved, setSaved] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await fetch('/auth/api/recovery-codes/status', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setStatus({ remaining: data.remaining, generatedAt: data.generatedAt });
        setUnavailable(false);
      } else if (res.status === 403) {
        setUnavailable(true);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerate() {
    if (status && status.remaining > 0) {
      const confirmed = globalThis.confirm(
        'Generating a new set of recovery codes invalidates all existing codes. Continue?',
      );
      if (!confirmed) return;
    }
    setError('');
    setGenerating(true);
    try {
      const res = await fetch('/auth/api/recovery-codes/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setCodes(data.codes);
        setDisclosure(data.disclosure || '');
        setSaved(false);
        setStatus({ remaining: data.count, generatedAt: data.generatedAt });
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error || 'Failed to generate recovery codes');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setGenerating(false);
    }
  }

  function downloadCodes() {
    if (!codes) return;
    const blob = new Blob([codes.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'imajin-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  }

  if (loading) return null;

  const remaining = status?.remaining ?? 0;
  const hasActiveCodes = remaining > 0;

  let statusLabel = 'No active recovery codes';
  if (hasActiveCodes) {
    statusLabel = `${remaining} unused code${remaining === 1 ? '' : 's'} remaining`;
  }

  let generateButtonLabel = hasActiveCodes ? 'Regenerate codes' : 'Generate codes';
  if (generating) {
    generateButtonLabel = 'Generating…';
  }

  return (
    <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
      <h2 className="text-lg font-semibold text-white mb-2">Recovery codes</h2>
      <p className="text-sm text-gray-400 mb-6">
        One-time codes that let you regain access if you lose your key. Store them offline — a password manager,
        printout, or USB drive. <span className="text-amber-400">These codes are verified by our server, not by
        cryptographic proof — this recovery path is not trustless</span> (the same trust class as an email magic link).
      </p>

      {unavailable ? (
        <p className="text-sm text-gray-500">Recovery codes require a self-custody identity.</p>
      ) : (
        <>
          {error && <p className="text-sm text-red-400 mb-4">{error}</p>}

          <div className="flex items-start justify-between py-2">
            <div>
              <p className="text-white font-medium">{statusLabel}</p>
              {status?.generatedAt && (
                <p className="text-sm text-gray-400 mt-1">
                  Generated {new Date(status.generatedAt).toLocaleDateString()}
                </p>
              )}
            </div>
            <button type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition disabled:opacity-50 whitespace-nowrap ml-4"
            >
              {generateButtonLabel}
            </button>
          </div>

          {/* Shown exactly once, right after generation */}
          {codes && (
            <div className="mt-4 p-4 bg-red-950/20 border border-red-800/50 rounded-lg">
              <p className="text-red-300 font-semibold text-sm mb-2">⚠️ Save these codes now — they will not be shown again</p>
              {disclosure && <p className="text-xs text-gray-400 mb-3">{disclosure}</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 font-mono text-sm text-white bg-black rounded-lg p-4 mb-4">
                {codes.map((c) => <div key={c}>{c}</div>)}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button"
                  onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}
                  className="text-sm px-3 py-1 border border-gray-700 text-gray-300 rounded hover:bg-gray-800 transition"
                >
                  Copy all
                </button>
                <button type="button"
                  onClick={downloadCodes}
                  className="text-sm px-3 py-1 border border-gray-700 text-gray-300 rounded hover:bg-gray-800 transition"
                >
                  Download
                </button>
                <button type="button"
                  onClick={() => setCodes(null)}
                  disabled={!saved}
                  className="ml-auto text-sm px-3 py-1 bg-green-700 text-white rounded hover:bg-green-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  I&apos;ve saved these codes
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
