'use client';

import { useState } from 'react';

export interface VerificationResult {
  valid: boolean;
  hashMatches: boolean;
  signaturesValid: boolean;
  revoked: boolean;
}

export default function DocumentVerification({ documentId }: Readonly<{ documentId: string }>) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!file || loading) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const response = await fetch(`/auth/api/documents/${encodeURIComponent(documentId)}/verify`, {
        method: 'POST', credentials: 'include', body,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Unable to verify this file');
      if (!['valid', 'hashMatches', 'signaturesValid', 'revoked'].every((key) => typeof data[key] === 'boolean')) {
        throw new Error('Invalid verification response');
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to verify this file');
    } finally {
      setLoading(false);
    }
  }

  const verified = result?.valid && result.hashMatches && result.signaturesValid && !result.revoked;
  return (
    <form onSubmit={verify} className="border border-zinc-700 p-3 space-y-3">
      <label className="block text-sm text-zinc-200" htmlFor={`verify-${documentId}`}>Verify a saved document</label>
      <p className="text-xs text-zinc-400">Upload your copy to compare its exact bytes with the signed hash and check the recorded signatures and revocation.</p>
      <input id={`verify-${documentId}`} type="file" className="block w-full min-w-0 text-xs text-zinc-300"
        onChange={(event) => { setFile(event.target.files?.[0] ?? null); setResult(null); setError(null); }} />
      <button type="submit" disabled={!file || loading} className="px-3 py-2 border border-zinc-600 text-sm text-white disabled:opacity-40">
        {loading ? 'Verifying…' : 'Verify file'}
      </button>
      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {result && (
        <output className={`block text-sm ${verified ? 'text-green-400' : 'text-red-400'}`}>
          {verified ? 'Verified: file matches and recorded signatures are valid.' : 'Verification failed.'}
          {!result.hashMatches && <span className="block">File does not match the signed document. It may have been changed or tampered with.</span>}
          {!result.signaturesValid && <span className="block">Recorded signatures could not be verified.</span>}
          {result.revoked && <span className="block">This agreement has been revoked.</span>}
        </output>
      )}
    </form>
  );
}
