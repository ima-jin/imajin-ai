'use client';

export type RelationshipLabel = 'client' | 'vendor' | 'partner' | 'other';
export type RelationshipFilter = 'all' | RelationshipLabel | 'unset';

export const RELATIONSHIP_FILTERS: ReadonlyArray<{ value: RelationshipFilter; text: string }> = [
  { value: 'all', text: 'All' },
  { value: 'client', text: 'Clients' },
  { value: 'vendor', text: 'Vendors' },
  { value: 'partner', text: 'Partners' },
  { value: 'other', text: 'Other' },
  { value: 'unset', text: 'Unset' },
];

export function filterRelationships<T extends { relationshipLabel?: RelationshipLabel | null }>(
  connections: T[],
  filter: RelationshipFilter,
): T[] {
  return connections
    .filter(connection => filter === 'all' || (connection.relationshipLabel ?? 'unset') === filter)
    .sort((a, b) => Number(b.relationshipLabel === 'client') - Number(a.relationshipLabel === 'client'));
}

export function ConnectionRelationshipFilter({
  value,
  onChange,
  disabled = false,
}: Readonly<{
  value: RelationshipFilter;
  onChange: (value: RelationshipFilter) => void;
  disabled?: boolean;
}>) {
  return (
    <fieldset aria-label="Filter relationships" className="flex flex-wrap gap-1 border-0 p-0 min-w-0">
      {RELATIONSHIP_FILTERS.map(filter => (
        <button
          key={filter.value}
          type="button"
          aria-pressed={value === filter.value}
          disabled={disabled}
          onClick={() => onChange(filter.value)}
          className={`px-3 py-1 text-xs rounded-full transition disabled:opacity-50 ${
            value === filter.value ? 'bg-amber-500 text-black' : 'bg-white/10 text-gray-400 hover:text-white'
          }`}
        >
          {filter.text}
        </button>
      ))}
    </fieldset>
  );
}
