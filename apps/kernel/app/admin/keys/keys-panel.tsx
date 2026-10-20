'use client';

import { useEffect, useRef, useState } from 'react';
import {
  PUBLIC_KEY, parseCustody, parseExport, parseHandoff, parsePublicPayload, parseRecorded,
  parseResealed, parseVerification, type Handoff, type PublicPayload,
} from './public-contract';

const SWEEP = '/api/vault/rotation-sweep';
const ROTATION = '/api/admin/keys/rotation';
const MAX_PUBLIC_FILE_BYTES = 16 * 1024;
const buttonClass = 'rounded bg-orange-600 px-4 py-2 text-white disabled:opacity-50';
const inputClass = 'block w-full mt-2 rounded border p-2 bg-white dark:bg-gray-900 font-mono text-sm';
function VerificationResult({ report }: Readonly<{ report: ReturnType<typeof parseVerification> }>) {
  return <div role="status" className="break-words">
    <p>{report.ok ? 'Key history verified.' : 'Key history verification failed. Resolve node configuration or history before continuing.'}</p>
    <p>Recorded rotations: {report.rotations}</p>
    <p>Current key ID: {report.currentKid ?? 'Unavailable'}</p>
    <p>Node DID: {report.nodeDid ?? 'Unavailable'} (source: {report.nodeDidSource})</p>
    <p>Signing process started at (UTC): {report.processStartedAt}</p>
  </div>;
}

async function request(url: string, body?: object): Promise<unknown> {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

export function KeysPanel() {
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [newKey, setNewKey] = useState('');
  const [anchor, setAnchor] = useState('');
  const [restarted, setRestarted] = useState(false);
  const [payload, setPayload] = useState<PublicPayload | null>(null);
  const [verification, setVerification] = useState<ReturnType<typeof parseVerification> | null>(null);
  const [anchored, setAnchored] = useState(false);
  const [custody, setCustody] = useState<ReturnType<typeof parseCustody> | null>(null);
  const [reimported, setReimported] = useState<number | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const uploadVersion = useRef(0);
  const statusVersion = useRef(0);

  useEffect(() => {
    let active = true;
    const version = ++statusVersion.current;
    request(SWEEP).then(parseHandoff).then((status) => {
      if (active && version === statusVersion.current) setHandoff(status);
    }).catch(() => {
      if (active && version === statusVersion.current) {
        setError('Unable to load handoff status. Refresh status before exporting.');
      }
    });
    return () => { active = false; };
  }, []);

  async function run(action: () => Promise<void>, failure: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await action();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  function verify(pinned: boolean) {
    if (pinned && !PUBLIC_KEY.test(anchor)) return;
    setVerification(null);
    setAnchored(pinned);
    void run(async () => {
      const suffix = pinned ? `?anchor=${encodeURIComponent(anchor)}` : '';
      setVerification(parseVerification(await request(`${ROTATION}${suffix}`)));
    }, 'Verification request failed. Check your admin session and node configuration, then retry.');
  }

  async function upload(file?: File) {
    const version = ++uploadVersion.current;
    setPayload(null);
    setRecorded(false);
    setError('');
    setMessage('');
    if (!file) return;
    try {
      if (file.size > MAX_PUBLIC_FILE_BYTES || !file.name.toLowerCase().endsWith('.json')) {
        throw new Error('Invalid file');
      }
      const parsed = parsePublicPayload(JSON.parse(await file.text()));
      if (version === uploadVersion.current) setPayload(parsed);
    } catch {
      if (version === uploadVersion.current) {
        setError('Upload only the public signed JSON payload with exactly the seven documented fields (maximum 16 KiB).');
      }
    }
  }

  return (
    <div className="space-y-6 text-gray-900 dark:text-gray-100">
      {error && <p role="alert" className="rounded border border-red-500 p-3">{error}</p>}
      {message && <p role="status" className="rounded border p-3">{message}</p>}
      <section className="rounded border p-4 space-y-3" aria-labelledby="custody-title">
        <h2 id="custody-title" className="text-lg font-semibold">0. Check v1 custody</h2>
        <p>Read-only go/no-go check. Do not rotate with remaining v1 entries; this page never applies a custody migration.</p>
        <button className={buttonClass} disabled={busy} onClick={() => {
          setCustody(null);
          void run(async () => {
            setCustody(parseCustody(await request('/api/vault/migrate-custody', { dryRun: true })));
          }, 'Custody check failed. Resolve custody status before rotating.');
        }}>Check v1 custody</button>
        {custody && <div role="status">
          <p>Remaining eligible v1 fields: {custody.totalV1Fields}. Candidates: {custody.candidateCount}.</p>
          <p>{custody.aborted || custody.totalV1Fields !== 0
            ? 'STOP: resolve custody migration before rotating.'
            : 'Eligible v1 custody check passed. Verify excluded custody separately.'}</p>
        </div>}
      </section>

      <section className="rounded border p-4 space-y-3" aria-labelledby="baseline-title">
        <h2 id="baseline-title" className="text-lg font-semibold">1. Verify baseline</h2>
        <p>Check the current signing key and recorded key history before beginning.</p>
        <button className={buttonClass} disabled={busy} onClick={() => verify(false)}>Verify baseline</button>
        {verification && !anchored && <VerificationResult report={verification} />}
      </section>

      <section className="rounded border p-4 space-y-3" aria-labelledby="sweep-title">
        <h2 id="sweep-title" className="text-lg font-semibold">2. Prepare encrypted vault handoff</h2>
        <p>With the old key still loaded, export to the new public key. The encrypted handoff stays on the server; no vault plaintext is sent to this browser.</p>
        <label className="block">New Ed25519 public key (64 hex characters)
          <input className={inputClass} aria-label="New Ed25519 public key" value={newKey}
            maxLength={64} autoComplete="off" spellCheck={false} disabled={busy || handoff?.pending}
            onChange={(event) => setNewKey(event.target.value)} />
        </label>
        <button className={buttonClass} disabled={busy || handoff?.pending !== false || !PUBLIC_KEY.test(newKey)}
          onClick={() => {
            if (!PUBLIC_KEY.test(newKey) || handoff?.pending !== false) return;
            void run(async () => {
              // An interrupted export can have succeeded; require a status refresh on failure.
              ++statusVersion.current;
              setHandoff(null);
              setHandoff(parseExport(await request(SWEEP, { phase: 'export', newPublicKey: newKey }), newKey));
              setRestarted(false);
              setReimported(null);
              setMessage('Encrypted handoff prepared. The new key is already installed in the env file; restart per the runbook, then reimport.');
            }, 'Export could not be confirmed. Refresh handoff status before retrying; do not restart until it is confirmed.');
          }}>Export encrypted handoff</button>
        <button className={buttonClass} disabled={busy} onClick={() => {
          void run(async () => {
            ++statusVersion.current;
            setHandoff(null);
            setHandoff(parseHandoff(await request(SWEEP)));
          }, 'Unable to load handoff status. Refresh status before exporting.');
        }}>Refresh handoff status</button>
        <div aria-live="polite">
          {handoff === null && <p>Handoff status unavailable or loading.</p>}
          {handoff?.pending === false && <p>No encrypted handoff pending.</p>}
          {handoff?.pending && <>
            <p>Encrypted handoff pending. Exported fields: {handoff.exported}</p>
            <p className="break-all">Target public key: {handoff.newPublicKey}</p>
          </>}
        </div>
      </section>

      <section className="rounded border p-4 space-y-3" aria-labelledby="reimport-title">
        <h2 id="reimport-title" className="text-lg font-semibold">3. Reimport after restart</h2>
        <p>The server must now be running with the new key. Reimport uses only the server-held encrypted handoff.</p>
        <label className="block">
          <input type="checkbox" checked={restarted} disabled={busy}
            onChange={(event) => setRestarted(event.target.checked)} /> I have restarted the node with the new key
        </label>
        <button className={buttonClass} disabled={busy || !handoff?.pending || !restarted}
          onClick={() => {
            if (!handoff?.pending || !restarted) return;
            setReimported(null);
            void run(async () => {
              const resealed = parseResealed(await request(SWEEP, { phase: 'reimport' }));
              if (resealed !== handoff.exported) throw new Error('Unexpected reimport count');
              setHandoff({ pending: false });
              setRestarted(false);
              setReimported(resealed);
            }, 'Reimport failed or could not be confirmed. Refresh status and retry after confirming the new key is loaded.');
          }}>Reimport encrypted handoff</button>
        {reimported !== null && <p role="status">Vault reimport complete. Resealed fields: {reimported}.</p>}
      </section>

      <section className="rounded border p-4 space-y-3" aria-labelledby="record-title">
        <h2 id="record-title" className="text-lg font-semibold">4. Record key.rotated</h2>
        <p>After restart, upload the PUBLIC dual-signed JSON from the offline signing step. Only public keys, key IDs, effective time, and signatures are accepted. The server verifies both signatures.</p>
        <label className="block">Public signed rotation JSON
          <input className="block mt-2" type="file" accept=".json,application/json" disabled={busy}
            onChange={(event) => { void upload(event.target.files?.[0]); }} />
        </label>
        {payload && <p>Public payload validated and ready for server verification.</p>}
        <button className={buttonClass} disabled={busy || !payload} onClick={() => {
          if (!payload) return;
          setRecorded(false);
          void run(async () => {
            parseRecorded(await request(ROTATION, payload));
            setPayload(null);
            setRecorded(true);
          }, 'Recording failed or could not be confirmed. Verify key history before retrying.');
        }}>Submit key.rotated</button>
        {recorded && <p role="status">key.rotated recorded. Verify from the old public anchor below.</p>}
      </section>

      <section className="rounded border p-4 space-y-3" aria-labelledby="anchor-title">
        <h2 id="anchor-title" className="text-lg font-semibold">5. Verify from the old public anchor</h2>
        <label className="block">Old pinned public anchor (64 hex characters)
          <input className={inputClass} aria-label="Old public anchor" value={anchor} maxLength={64}
            autoComplete="off" spellCheck={false} disabled={busy} onChange={(event) => setAnchor(event.target.value)} />
        </label>
        <button className={buttonClass} disabled={busy || !PUBLIC_KEY.test(anchor)}
          onClick={() => verify(true)}>Verify anchored history</button>
        {verification && anchored && <VerificationResult report={verification} />}
      </section>
    </div>
  );
}
