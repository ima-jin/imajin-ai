/** Only signed import metadata is visible here; no generic detail dump. */
export function VaultImportApproval({ detail }: Readonly<{ detail: Record<string, unknown> | null }>) {
  const fields = [
    ['ownerDid', 'Owning identity'],
    ['consumerDid', 'Consumer agent or service'],
    ['purpose', 'Purpose'],
    ['label', 'Label'],
    ['fingerprint', 'Fingerprint'],
    ['expiresAt', 'Grant expiry'],
    ['replacesField', 'Replaces'],
  ];
  return (
    <div className="space-y-2 text-xs text-gray-300" data-testid="vault-import-approval">
      <p>The identity below owns the sealed credential. Your signature authorizes its purpose-bound grant; the node executes.</p>
      <dl className="space-y-1">
        {fields.map(([key, label]) => (
          <div key={key} className="break-all">
            <dt className="inline font-medium text-gray-500">{label}: </dt>
            <dd className="inline">{typeof detail?.[key] === 'string' ? detail[key] as string : '—'}</dd>
          </div>
        ))}
      </dl>
      {typeof detail?.replacesField === 'string' && <p className="text-amber-300">
        Re-import rotation: grant the replacement, then revoke the old access as one signed operation.
      </p>}
      <p>No reveal. The credential is not part of this approval record.</p>
    </div>
  );
}
