/** Display only signed renewal metadata, never generic custody records or material. */
export function VaultRenewalApproval({ detail }: Readonly<{ detail: Record<string, unknown> | null }>) {
  const fields = [
    ['orgDid', 'Owning organization'], ['provider', 'Provider'],
    ['previousExpiresAt', 'Previous grant expiry'], ['expiresAt', 'New grant expiry'],
  ];
  return <div className="space-y-2 text-xs text-gray-300">
    <p>Renew the existing org-held key grant. Irreversible custody action: your owner/admin countersignature authorizes the node to extend access.</p>
    <dl>{fields.map(([key, label]) => <div key={key} className="break-all">
      <dt className="inline text-gray-500">{label}: </dt>
      <dd className="inline">{typeof detail?.[key] === 'string' ? detail[key] as string : '—'}</dd>
    </div>)}</dl>
    <p>No reveal, replacement or new consumer. The sealed entry and wrapped key material stay unchanged.</p>
  </div>;
}
