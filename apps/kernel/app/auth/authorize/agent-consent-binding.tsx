'use client';

import { useRef, useState } from 'react';

export interface SelectedAgentBinding { agentDid: string; principalDid: string }
interface Choices {
  agent: { did: string; handle: string | null };
  principals: Array<{ did: string; handle: string | null; name: string | null }>;
}

/** A placeholder remains selected even when exactly one assignment is available. */
export function AgentConsentBinding({ initialAgentDid, onChange }: Readonly<{
  initialAgentDid: string;
  onChange: (binding: SelectedAgentBinding | null) => void;
}>) {
  const [agentDid, setAgentDid] = useState(initialAgentDid);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [principalDid, setPrincipalDid] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  async function loadChoices() {
    const id = ++requestId.current;
    setChoices(null);
    setPrincipalDid('');
    setError('');
    setLoading(true);
    onChange(null);
    try {
      const response = await fetch(`/oauth/agent-bindings?agent_did=${encodeURIComponent(agentDid)}`, {
        credentials: 'include', cache: 'no-store',
      });
      const data = await response.json();
      if (id !== requestId.current) return;
      if (!response.ok) {
        setError(`${data.error}: ${data.error_description ?? 'Agent consent refused.'}`);
        return;
      }
      setChoices(data);
    } catch {
      if (id === requestId.current) setError('agent_binding_unavailable: Retry loading assignments.');
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }

  function changeAgent(value: string) {
    ++requestId.current;
    setLoading(false);
    setAgentDid(value);
    setChoices(null);
    setPrincipalDid('');
    setError('');
    onChange(null);
  }

  return (
    <section className="mb-6 space-y-3 text-sm text-gray-300" aria-label="Agent OAuth binding">
      <label className="block">
        <span>Agent DID (token subject)</span>
        <input className="mt-1 w-full rounded bg-gray-900 p-2" value={agentDid}
          onChange={event => changeAgent(event.target.value)} autoComplete="off" />
      </label>
      <button type="button" className="rounded bg-gray-800 px-3 py-2"
        disabled={loading || !agentDid} onClick={loadChoices}>
        {loading ? 'Loading assignments…' : 'Load assigned identities'}
      </button>
      {error && <p role="alert" className="text-red-400">{error}</p>}
      {choices && <>
        <p className="break-all">Agent: {choices.agent.handle ? `@${choices.agent.handle} · ` : ''}{choices.agent.did}</p>
        <label className="block">
          <span>Assigned identity (keys and billing)</span>
          <select className="mt-1 w-full rounded bg-gray-900 p-2" value={principalDid}
            onChange={event => {
              const selected = event.target.value;
              setPrincipalDid(selected);
              onChange(selected ? { agentDid: choices.agent.did, principalDid: selected } : null);
            }}>
            <option value="">Select one assigned DID explicitly</option>
            {choices.principals.map(principal => <option key={principal.did} value={principal.did}>
              {principal.handle ? `@${principal.handle} · ` : ''}{principal.did}
            </option>)}
          </select>
        </label>
      </>}
      {principalDid && <output className="block break-all" aria-live="polite">
        {choices?.agent.did} will act for {principalDid}. This token cannot switch identities.
      </output>}
      <p className="text-xs text-gray-500">Only the assigned human or an org admin may approve.
        Each agent needs its own consent and token; never share a token across a gateway.</p>
    </section>
  );
}
