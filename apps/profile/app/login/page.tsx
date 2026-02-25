'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useIdentity } from '../context/IdentityContext';

type ImportMethod = 'file' | 'paste';

export default function LoginPage() {
  const router = useRouter();
  const { importKeys } = useIdentity();
  const [method, setMethod] = useState<ImportMethod>('file');
  const [privateKeyHex, setPrivateKeyHex] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  async function handleFileSelect(file: File) {
    setError('');
    setLoading(true);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.keypair?.privateKey) {
        throw new Error('Invalid backup file format. Missing keypair.privateKey');
      }

      const result = await importKeys(data.keypair.privateKey);

      if (result.success) {
        router.push(`/${result.handle || result.did}`);
      } else {
        setError(result.error || 'Import failed');
      }
    } catch (err: any) {
      console.error('File import failed:', err);
      setError(err.message || 'Failed to import backup file');
    } finally {
      setLoading(false);
    }
  }

  async function handlePasteImport(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await importKeys(privateKeyHex.trim());

      if (result.success) {
        router.push(`/${result.handle || result.did}`);
      } else {
        setError(result.error || 'Import failed');
      }
    } catch (err: any) {
      console.error('Manual import failed:', err);
      setError(err.message || 'Failed to import key');
    } finally {
      setLoading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);

    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/json') {
      handleFileSelect(file);
    } else {
      setError('Please drop a valid JSON backup file');
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
        <h1 className="text-2xl font-bold mb-2 text-center text-white">Login / Recovery</h1>
        <p className="text-gray-400 text-center mb-6">
          Import your private key to access your identity
        </p>

        {/* Method selector */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMethod('file')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${
              method === 'file'
                ? 'bg-[#F59E0B] text-black font-medium'
                : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
            }`}
          >
            Import File
          </button>
          <button
            onClick={() => setMethod('paste')}
            className={`flex-1 px-4 py-2 rounded-lg transition ${
              method === 'paste'
                ? 'bg-[#F59E0B] text-black font-medium'
                : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
            }`}
          >
            Paste Key
          </button>
        </div>

        {/* File import */}
        {method === 'file' && (
          <div>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`border-2 border-dashed rounded-lg p-8 text-center transition ${
                dragOver
                  ? 'border-[#F59E0B] bg-[#F59E0B]/10'
                  : 'border-gray-700 hover:border-gray-600'
              }`}
            >
              <div className="text-4xl mb-3">📁</div>
              <p className="text-gray-300 mb-2">Drag & drop your backup file here</p>
              <p className="text-sm text-gray-500 mb-4">or</p>
              <label className="inline-block px-6 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition cursor-pointer font-medium">
                Choose File
                <input
                  type="file"
                  accept="application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFileSelect(file);
                  }}
                  className="hidden"
                  disabled={loading}
                />
              </label>
            </div>
          </div>
        )}

        {/* Paste key */}
        {method === 'paste' && (
          <form onSubmit={handlePasteImport} className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-gray-300">
                Private Key (hex)
              </label>
              <textarea
                value={privateKeyHex}
                onChange={(e) => setPrivateKeyHex(e.target.value)}
                placeholder="64 character hex string..."
                rows={4}
                required
                className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white font-mono text-sm focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent resize-none"
              />
              <p className="text-xs text-gray-500 mt-1">
                Your private key is 64 hexadecimal characters
              </p>
            </div>

            <button
              type="submit"
              disabled={loading || !privateKeyHex.trim()}
              className="w-full px-6 py-3 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? 'Importing...' : 'Import & Login'}
            </button>
          </form>
        )}

        {/* Error display */}
        {error && (
          <div className="mt-4 p-3 bg-red-900/20 border border-red-800 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="mt-4 text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F59E0B]"></div>
            <p className="text-sm text-gray-400 mt-2">Importing keys...</p>
          </div>
        )}

        {/* Info box */}
        <div className="mt-6 p-4 bg-gray-900 border border-gray-800 rounded-lg">
          <p className="text-sm text-gray-400">
            <strong className="text-white">Don't have an account?</strong>
            <br />
            <button
              onClick={() => router.push('/register')}
              className="text-[#F59E0B] hover:underline mt-1 inline-block"
            >
              Create a new identity →
            </button>
          </p>
        </div>

        {/* Security warning */}
        <div className="mt-4 p-3 bg-[#F59E0B]/10 border border-[#F59E0B]/30 rounded-lg">
          <p className="text-xs text-[#F59E0B]">
            🔐 Your private key never leaves your device. It's only stored locally in your browser.
          </p>
        </div>
      </div>
    </div>
  );
}
