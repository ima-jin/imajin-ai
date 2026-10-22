'use client';

import { useEffect, useState } from 'react';
import { RunsPanel } from '@/app/jin/runs-panel';
import { installRunsPreview } from './transport';
import type { SessionCommandClient } from '@/app/jin/session-command-client';

export function RunsPreview() {
  const [ready, setReady] = useState(false);
  const [client, setClient] = useState<SessionCommandClient>();
  const [error, setError] = useState('');
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let stopped = false;
    void installRunsPreview().then((fixture) => {
      if (stopped) fixture.dispose();
      else { dispose = fixture.dispose; setClient(fixture.client); setReady(true); }
    }).catch(() => setError('Fixture initialization failed.'));
    return () => { stopped = true; dispose?.(); };
  }, []);
  return <main className="mx-auto max-w-3xl min-w-0 p-4">
    <h1 className="text-xl font-semibold">Runs · development fixture</h1>
    <nav className="my-3 flex flex-wrap gap-4 text-sm text-indigo-300" aria-label="Blocker reconciliation fixtures">
      <a href="?blockers=before">Before reconciliation</a>
      <a href="?blockers=after">After reconciliation</a>
    </nav>
    <p className="my-3 text-sm text-amber-300">Mock transport, generated browser signing identity, exact #77 envelopes. No live gateway execution. Live round-trip remains pending plugin #77.</p>
    {error && <p role="alert">{error}</p>}
    {ready && <RunsPanel client={client} />}
  </main>;
}
