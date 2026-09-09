// Pure formatting helpers for the admin user detail page (#2119).
// Kept out of page.tsx: Next.js's Page type validation rejects any named
// export from a page.tsx file other than the reserved ones (metadata,
// generateStaticParams, etc.) — "X is not a valid Page export field".

export function computeShortKey(publicKey: string | null | undefined): string {
  return publicKey ? `${publicKey.slice(0, 20)}…${publicKey.slice(-8)}` : '—';
}

export function formatCreatedTimestamp(createdAt: Date | null | undefined): string {
  return createdAt
    ? new Date(createdAt).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
    : '—';
}
