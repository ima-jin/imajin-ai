'use client';

import { useState } from 'react';
import SignerList from './SignerList';
import DocumentViewer from './DocumentViewer';

interface Signature {
  id: string;
  signerDid: string;
  status: string;
  role: string;
  signedAt: Date | null;
  identity?: {
    handle: string | null;
    name: string | null;
    avatarUrl: string | null;
  } | null;
}

interface DocumentAttestation {
  id: string;
  issuerDid: string;
  subjectDid: string;
  type: string;
  payload: Record<string, unknown> | null;
  attestationStatus: string | null;
  documentHash: string | null;
  documentAssetId: string | null;
  totalSigners: number | null;
  issuedAt: Date;
  expiresAt: Date | null;
}

interface Props {
  attestation: DocumentAttestation;
  signatures: Signature[];
  sessionDid: string;
}

function statusBadge(status: string | null): { label: string; classes: string } {
  switch (status) {
    case 'collecting':
      return { label: 'collecting', classes: 'bg-amber-900/30 text-amber-400 border-amber-800' };
    case 'executed':
      return { label: 'executed', classes: 'bg-green-900/30 text-green-400 border-green-800' };
    case 'declined':
      return { label: 'declined', classes: 'bg-red-900/30 text-red-400 border-red-800' };
    case 'expired':
      return { label: 'expired', classes: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
    default:
      return { label: status ?? 'unknown', classes: 'bg-zinc-800 text-zinc-400 border-zinc-700' };
  }
}

function resolvedName(
  did: string,
  identity: { handle?: string | null; name?: string | null } | undefined
): string {
  if (identity?.handle) return `@${identity.handle}`;
  if (identity?.name) return identity.name;
  return did.slice(0, 22) + '…';
}

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function expiryLabel(expiresAt: Date | null): string | null {
  if (!expiresAt) return null;
  const diff = expiresAt.getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const hrs = Math.floor(diff / (1000 * 60 * 60));
  if (hrs < 24) return `${hrs}h left`;
  const days = Math.floor(hrs / 24);
  return `${days}d left`;
}

export default function DocumentSigningCard({ attestation, signatures, sessionDid }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localStatus, setLocalStatus] = useState(attestation.attestationStatus);
  const [localSigs, setLocalSigs] = useState(signatures);

  const badge = statusBadge(localStatus);
  const isCreator = attestation.issuerDid === sessionDid;
  const mySig = localSigs.find((s) => s.signerDid === sessionDid);
  const canSign = mySig?.status === 'pending' && localStatus === 'collecting';
  const canDecline = mySig?.status === 'pending' && localStatus === 'collecting';
  const signedCount = localSigs.filter((s) => s.status === 'signed').length;
  const totalCount = attestation.totalSigners ?? localSigs.length;

  const title = (attestation.payload?.title as string) ?? 'Untitled Document';

  async function handleSign() {
    setLoading(true);
    setError(null);
    try {
      // Client must provide their JWS and document_hash
      // For now, we prompt for JWS (in a real app this would be auto-generated from stored keys)
      const jws = window.prompt('Paste your JWS signature for this document:');
      if (!jws) {
        setLoading(false);
        return;
      }

      const res = await fetch(`/auth/api/documents/${attestation.id}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jws,
          document_hash: attestation.documentHash,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Sign failed');
        setLoading(false);
        return;
      }

      setLocalStatus(data.status);
      // Refresh signatures
      const detailRes = await fetch(`/auth/api/documents/${attestation.id}`);
      if (detailRes.ok) {
        const detail = await detailRes.json();
        setLocalSigs(detail.signatures);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleDecline() {
    if (!window.confirm('Are you sure you want to decline signing this document?')) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/auth/api/documents/${attestation.id}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Decline failed');
        setLoading(false);
        return;
      }

      setLocalStatus('declined');
      const detailRes = await fetch(`/auth/api/documents/${attestation.id}`);
      if (detailRes.ok) {
        const detail = await detailRes.json();
        setLocalSigs(detail.signatures);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decline failed');
    } finally {
      setLoading(false);
    }
  }

  const expiry = expiryLabel(attestation.expiresAt);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      {/* Header */}
      <div
        className="px-5 py-4 flex items-center gap-3 cursor-pointer hover:bg-zinc-800/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${badge.classes}`}>
          {badge.label}
        </span>

        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-zinc-200 truncate">
            {title}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {signedCount}/{totalCount} signed
            {expiry && (
              <span className="ml-2 text-zinc-600">· {expiry}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {canSign && (
            <button
              onClick={(e) => { e.stopPropagation(); handleSign(); }}
              disabled={loading}
              className="px-3 py-1 bg-amber-500 hover:bg-amber-400 disabled:bg-zinc-700 text-black text-xs font-medium rounded-lg transition-colors"
            >
              {loading ? '...' : 'Sign'}
            </button>
          )}
          {canDecline && (
            <button
              onClick={(e) => { e.stopPropagation(); handleDecline(); }}
              disabled={loading}
              className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-800 text-zinc-300 text-xs font-medium rounded-lg transition-colors"
            >
              Decline
            </button>
          )}
          <svg
            className={`w-4 h-4 text-zinc-600 transition-transform ${expanded ? 'rotate-180' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </div>

      {/* Expanded */}
      {expanded && (
        <div className="px-5 pb-5 border-t border-zinc-800/60 space-y-4">
          {error && (
            <div className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          {/* Document viewer */}
          {attestation.documentAssetId && (
            <div className="pt-3">
              <DocumentViewer
                assetId={attestation.documentAssetId}
                mimeType="application/pdf"
                filename={title}
                hash={attestation.documentHash ?? ''}
              />
            </div>
          )}

          {/* Signer list */}
          <div>
            <h4 className="text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">
              Signers
            </h4>
            <SignerList signers={localSigs} sessionDid={sessionDid} />
          </div>

          {/* Meta */}
          <div className="text-xs text-zinc-600 space-y-1">
            <div className="flex gap-2">
              <span className="w-16 shrink-0">Created</span>
              <span>{relativeTime(attestation.issuedAt)}</span>
            </div>
            <div className="flex gap-2">
              <span className="w-16 shrink-0">By</span>
              <span className="font-mono">{attestation.issuerDid}</span>
            </div>
            {attestation.expiresAt && (
              <div className="flex gap-2">
                <span className="w-16 shrink-0">Expires</span>
                <span>{attestation.expiresAt.toLocaleString()}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
