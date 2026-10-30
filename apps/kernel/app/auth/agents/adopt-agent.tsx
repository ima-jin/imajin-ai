'use client';

import { useState } from 'react';
import { sign } from '@/src/lib/auth/browser-keys';

async function adoptionRequest(body: Record<string, unknown>) {
  const response = await fetch('/auth/api/agents/adopt', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Adoption failed');
  return data;
}

/** The uploaded key is read and used locally, never serialized into a request. */
export default function AdoptAgent({ orgDid, onAdopted }: Readonly<{ orgDid: string; onAdopted: () => Promise<void> }>) {
  const [agentDid, setAgentDid] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function adopt() {
    if (!keyFile) return;
    setBusy(true);
    setMessage('');
    try {
      let key: { did?: string; privateKey?: string };
      try {
        key = JSON.parse(await keyFile.text());
        if (key.did !== agentDid || !/^[a-f0-9]{64}$/i.test(key.privateKey ?? '')) throw new Error('Invalid key');
      } catch {
        throw new Error('Choose the original keypair JSON for this agent DID');
      }
      const proof = await adoptionRequest({
        action: 'challenge', agentDid, capabilities: capabilities.split(',').map(c => c.trim()).filter(Boolean),
      });
      const signature = await sign(proof.challenge, key.privateKey!);
      await adoptionRequest({ action: 'adopt', challengeId: proof.challengeId, signature });
      setMessage('Agent adopted. DID and keypair unchanged.');
      setKeyFile(null);
      await onAdopted();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Adoption failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Adopt orphaned agent" className="rounded-xl border border-gray-800 p-4 space-y-3 text-gray-400">
      <h2 className="text-lg font-semibold text-white">Adopt orphaned agent</h2>
      <p className="text-sm break-all">Adopt into {orgDid}. Requires the original agent keypair and no membership, active grant, or provision. The private key stays in your browser.</p>
      <label className="block" htmlFor="adopt-agent-did">Orphan agent DID</label>
      <input id="adopt-agent-did" value={agentDid} onChange={e => setAgentDid(e.target.value.trim())}
        className="w-full min-w-0 rounded bg-black border border-gray-700 p-2" />
      <label className="block" htmlFor="adopt-capabilities">Adoption capabilities</label>
      <input id="adopt-capabilities" value={capabilities} onChange={e => setCapabilities(e.target.value)}
        placeholder="messages:write" className="w-full min-w-0 rounded bg-black border border-gray-700 p-2" />
      <label className="block" htmlFor="adopt-keypair">Original agent keypair JSON (local only)</label>
      <input id="adopt-keypair" type="file" accept=".json,application/json" disabled={busy}
        onChange={e => setKeyFile(e.target.files?.[0] ?? null)} className="w-full min-w-0" />
      <button type="button" onClick={adopt} disabled={busy || !keyFile || !agentDid || !capabilities.trim()}
        className="px-3 py-2 bg-amber-500 text-black rounded disabled:opacity-50">
        {busy ? 'Adopting…' : 'Sign proof & adopt agent'}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
