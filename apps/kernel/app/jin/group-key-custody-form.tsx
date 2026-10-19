'use client';

import { useState, type FormEvent } from 'react';

export type GroupCustodyAction = 'custody-group-key' | 'revoke-group-key';

/** This form accepts identifiers only. There is no key input, reveal or copy path. */
export function GroupKeyCustodyForm({ busy, onPropose }: Readonly<{
  busy: boolean;
  onPropose: (kind: GroupCustodyAction, detail: Record<string, unknown>) => Promise<void>;
}>) {
  const [groupDid, setGroupDid] = useState('');
  const [purpose, setPurpose] = useState('domain.issue');
  const [action, setAction] = useState<GroupCustodyAction>('custody-group-key');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    await onPropose(action, { groupDid: groupDid.trim(), purpose: purpose.trim() });
  };
  return (
    <form onSubmit={submit} className="rounded-lg border border-gray-800 p-3 space-y-2" aria-label="Group signing-key custody">
      <h3 className="text-sm text-gray-200">Group signing-key custody</h3>
      <p className="text-xs text-gray-500">
        Propose access for this node, then countersign in the approval inbox.
        The existing group key stays inside the kernel. Revocation stops future use; it does not rotate the group identity.
      </p>
      <label className="block text-xs text-gray-400">
        <span>Group DID</span>
        <input required value={groupDid} onChange={e => setGroupDid(e.target.value)} maxLength={256}
          className="block min-h-[44px] w-full rounded bg-gray-900 p-2 text-gray-200" placeholder="did:imajin:…" />
      </label>
      <label className="block text-xs text-gray-400">
        <span>Purpose</span>
        <input required value={purpose} onChange={e => setPurpose(e.target.value)} maxLength={200}
          className="block min-h-[44px] w-full rounded bg-gray-900 p-2 text-gray-200" />
      </label>
      <label className="block text-xs text-gray-400">
        <span>Action</span>
        <select value={action} onChange={e => setAction(e.target.value as GroupCustodyAction)}
          className="block min-h-[44px] w-full rounded bg-gray-900 p-2 text-gray-200">
          <option value="custody-group-key">Grant custody to this node</option>
          <option value="revoke-group-key">Revoke this node’s purpose grant</option>
        </select>
      </label>
      <button type="submit" disabled={busy} className="min-h-[44px] rounded bg-gray-700 px-3 py-2 text-xs text-gray-200 disabled:opacity-40">
        Propose group key action
      </button>
    </form>
  );
}
