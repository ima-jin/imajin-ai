'use client';

import { useState } from 'react';

export type RelationshipLabel = 'client' | 'vendor' | 'partner' | 'other';
export type RelationshipFilter = 'all' | RelationshipLabel | 'unset';

const LABELS: ReadonlyArray<RelationshipLabel> = ['client', 'vendor', 'partner', 'other'];

export function matchesRelationship(
  connection: { relationshipLabel?: RelationshipLabel | null },
  filter: RelationshipFilter,
) {
  return filter === 'all' || (connection.relationshipLabel ?? 'unset') === filter;
}

export function RelationshipFilterControl({
  value,
  onChange,
}: Readonly<{ value: RelationshipFilter; onChange: (value: RelationshipFilter) => void }>) {
  return (
    <label className="block text-sm text-gray-400 mb-4">
      Relationship
      <select
        value={value}
        onChange={event => onChange(event.target.value as RelationshipFilter)}
        className="ml-2 px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white capitalize"
      >
        <option value="all">All</option>
        {LABELS.map(label => <option key={label} value={label}>{label}</option>)}
        <option value="unset">Unset</option>
      </select>
    </label>
  );
}

export function RelationshipEditor({
  did,
  name,
  value,
  canManage,
  onSave,
}: Readonly<{
  did: string;
  name: string;
  value: RelationshipLabel | null;
  canManage: boolean;
  onSave: (did: string, label: RelationshipLabel | null) => void;
}>) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(label: RelationshipLabel | null) {
    if (saving || label === value) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/connections/api/connections/${encodeURIComponent(did)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationshipLabel: label }),
      });
      if (!response.ok) throw new Error('Failed to save relationship label. Please try again.');
      onSave(did, label);
    } catch {
      setError('Failed to save relationship label. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!canManage) {
    return <span className="text-xs text-amber-400 capitalize">{value ?? 'Unset'}</span>;
  }

  return (
    <div className="mt-1">
      <select
        aria-label={`Relationship for ${name}`}
        value={value ?? ''}
        disabled={saving}
        onChange={event => { void save((event.target.value || null) as RelationshipLabel | null); }}
        className="text-xs px-2 py-1 bg-gray-900 border border-gray-600 rounded text-white capitalize disabled:opacity-50"
      >
        <option value="">Unset</option>
        {LABELS.map(label => <option key={label} value={label}>{label}</option>)}
      </select>
      {saving && <span role="status" className="ml-2 text-xs text-gray-400">Saving…</span>}
      {error && <p role="alert" className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}
