'use client';

import { useState } from 'react';
import { GrantsPanel } from '../../jin/grants-panel';
import { createGrantsFixtureTransport } from './fixture-transport';
import styles from '../../jin/grants-panel.module.css';

export default function GrantsPreview() {
  const [transport] = useState(() => createGrantsFixtureTransport());
  return (
    <main className={`${styles.preview} min-h-screen p-4`}>
      <div className="max-w-4xl mx-auto">
        <h1 className="font-mono text-xl">Grants preview</h1>
        <p className="mt-2 text-sm text-gray-400">
          Development fixture API transport — real Grants panel, in-memory data only.
          No live authorization, revoke API, database, or credentials are used.
          Reload to reset. Includes a same-label different-DID app, an expired grant, and revoked history.
        </p>
        <GrantsPanel transport={transport} />
      </div>
    </main>
  );
}
