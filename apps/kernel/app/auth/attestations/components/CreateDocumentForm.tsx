'use client';

import { useState, useRef, useCallback } from 'react';
import IdentityPicker from '../../components/IdentityPicker';
import { buildDocumentSigningPayload } from '@/src/lib/auth/document-signing-payload';

interface Props {
  sessionDid: string;
  onCreated?: () => void;
}

interface LookupResult {
  did: string;
  handle: string | null;
  name: string | null;
}

export default function CreateDocumentForm({ sessionDid, onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'upload' | 'details' | 'preview'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [assetHash, setAssetHash] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [signers, setSigners] = useState<LookupResult[]>([]);
  const [expiry, setExpiry] = useState<'24h' | '7d' | '1m' | '1y' | 'never'>('7d');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) {
      setFile(selected);
      setTitle(selected.name);
    }
  }, []);

  async function handleUpload() {
    if (!file) return;
    setUploading(true);
    setError(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('filename', file.name);
    formData.append('context', JSON.stringify({ app: 'auth', feature: 'signed' }));

    try {
      const res = await fetch('/media/api/assets', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Upload failed');
        setUploading(false);
        return;
      }
      setAssetId(data.id);
      setAssetHash(data.hash);
      setStep('details');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function addSigner(identity: { did: string; handle: string | null; name: string | null }) {
    if (!identity.did || signers.some((s) => s.did === identity.did)) return;
    setSigners((prev) => [...prev, { did: identity.did, handle: identity.handle, name: identity.name }]);
  }

  function removeSigner(did: string) {
    setSigners((prev) => prev.filter((s) => s.did !== did));
  }

  async function handleSubmit() {
    if (!assetId || !assetHash || !title.trim() || signers.length === 0) return;

    setLoading(true);
    setError(null);

    try {
      const signRes = await fetch(`/auth/api/identity/${encodeURIComponent(sessionDid)}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: buildDocumentSigningPayload(sessionDid, assetHash),
        }),
      });
      const signData = await signRes.json();
      if (!signRes.ok) {
        setError(signData.error ?? 'Failed to sign document hash');
        setLoading(false);
        return;
      }
      if (!signData.signature || typeof signData.signature !== 'string') {
        setError(signData.reason ? `Unable to sign: ${signData.reason}` : 'Unable to sign document hash');
        setLoading(false);
        return;
      }
      const res = await fetch('/auth/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          document_asset_id: assetId,
          document_hash: assetHash,
          signers: signers.map((s) => s.did),
          expiry,
          author_jws: signData.signature,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Create failed');
        setLoading(false);
        return;
      }

      setOpen(false);
      setStep('upload');
      setFile(null);
      setAssetId(null);
      setAssetHash(null);
      setTitle('');
      setSigners([]);
      setExpiry('7d');
      onCreated?.();
      globalThis.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black text-sm font-medium rounded-lg transition-colors"
      >
        + New Document
      </button>
    );
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-white">New Document Signing</h3>
        <button
          onClick={() => setOpen(false)}
          className="text-zinc-500 hover:text-zinc-300 text-sm"
        >
          ✕
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-3">
          <button
            type="button"
            className="border-2 border-dashed border-zinc-700 rounded-lg p-8 text-center cursor-pointer hover:border-amber-500 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="text-3xl mb-2">📄</div>
            <div className="text-sm text-zinc-400">
              {file ? file.name : 'Click to select a document'}
            </div>
            <div className="text-xs text-zinc-600 mt-1">
              PDF, images, text files accepted
            </div>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            accept=".pdf,.txt,.md,image/*"
            onChange={handleFileChange}
          />
          <button
            onClick={handleUpload}
            disabled={!file || uploading}
            className="w-full px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-800 text-black text-sm font-medium rounded-lg transition-colors"
          >
            {uploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      )}

      {step === 'details' && (
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Title</label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
              placeholder="Document title"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Signers</label>
            <IdentityPicker
              onSelect={addSigner}
              placeholder="Search by handle, name, or DID…"
              excludeDids={[sessionDid, ...signers.map((s) => s.did)]}
            />
            {signers.length > 0 && (
              <div className="mt-2 space-y-1">
                {signers.map((s) => (
                  <div key={s.did} className="flex items-center gap-2 px-3 py-1.5 bg-black/40 rounded-lg">
                    <span className="text-sm text-zinc-300">
                      {s.handle ? `@${s.handle}` : s.name ?? s.did.slice(0, 22) + '…'}
                    </span>
                    <span className="text-xs text-zinc-600 font-mono">{s.did}</span>
                    <button
                      onClick={() => removeSigner(s.did)}
                      className="ml-auto text-zinc-500 hover:text-red-400 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs text-zinc-500 mb-1.5">Expiry</label>
            <select
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as typeof expiry)}
              className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white focus:border-amber-500 focus:outline-none"
            >
              <option value="24h">24 hours</option>
              <option value="7d">7 days</option>
              <option value="1m">1 month</option>
              <option value="1y">1 year</option>
              <option value="never">Never</option>
            </select>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => setStep('upload')}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleSubmit}
              disabled={loading || !title.trim() || signers.length === 0}
              className="flex-1 px-4 py-2 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-800 text-black text-sm font-medium rounded-lg transition-colors"
            >
              {loading ? 'Creating...' : 'Create Signing Request'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
