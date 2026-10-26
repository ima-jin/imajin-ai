'use client';

import { useState } from 'react';
import { isWarpBrief } from '@/src/lib/warp/brief';

export function RunBrief({ value }: Readonly<{ value: unknown }>) {
  const [text, setText] = useState<string | null>(null);
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);
  if (!isWarpBrief(value)) return null;
  const brief = value;

  async function open() {
    setBusy(true);
    setText(null);
    setResult('');
    try {
      const response = await fetch(`/media/api/assets/${encodeURIComponent(brief.assetId!)}`, {
        credentials: 'include', cache: 'no-store', headers: { Accept: 'application/octet-stream' },
      });
      if (!response.ok) throw new Error('Unavailable');
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      setResult(hash === brief.hash ? 'Hash matches dispatch event' : 'Hash mismatch — brief integrity check failed');
      if (hash === brief.hash) setText(new TextDecoder().decode(bytes));
    } catch { setResult('Brief unavailable or access denied'); }
    finally { setBusy(false); }
  }

  return <section className="min-w-0 space-y-2 border border-gray-700 p-3" aria-label="Run brief">
    <p className="break-all font-mono">SHA-256: {brief.hash}</p>
    <p>Browser testing: {brief.browserTesting ?? 'not specified'}</p>
    {brief.storage === 'hash-only' ? <p>brief stored as hash only</p> : <>
      <a className="inline-flex min-h-11 items-center break-all text-indigo-300"
        href={`/media/api/assets/${encodeURIComponent(brief.assetId!)}`}>Brief asset: {brief.assetId}</a>
      <button type="button" className="block min-h-11 text-indigo-300" disabled={busy} onClick={() => void open()}>
        {busy ? 'Verifying brief…' : 'Open and verify brief'}
      </button>
    </>}
    {result && <p role="status">{result}</p>}
    {text !== null && <pre className="whitespace-pre-wrap break-words">{text}</pre>}
  </section>;
}
