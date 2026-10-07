/**
 * Read-only preview of the `providesScopes` / `dependsOn` / `emittableEvents` an
 * `apps.provision` proposal will register (#2663, #2638) — `emittableEvents` is the
 * list of event types the app will be allowed to emit via `POST /api/events`
 * (notify and audit only — never money) — rendered on the existing apps.provision card
 * in Operator approvals, so the operator sees the list BEFORE approving it.
 *
 * It adds no endpoint and no authority: the list comes from the proposal's own
 * `detail.manifestDeclarations`, snapshotted from `imajin.app.json` when the
 * proposal was raised and covered by the hash the operator signs. Approving
 * registers exactly this list and nothing beyond it (`registerApp` refuses a
 * manifest that has drifted from it).
 *
 * `detail` is untrusted JSON, so it is parsed defensively; anything that isn't
 * the expected shape is treated the same as "nothing was read".
 */
import type { ReactNode } from 'react';
import { parseManifestDeclarations } from '@/src/lib/apps/declarations-approval';

function Row({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="text-xs text-gray-500">
      <span className="uppercase tracking-wide mr-2">{label}</span>
      {children}
    </div>
  );
}

export function ProvisionDeclarationsPreview({ detail }: Readonly<{ detail: Record<string, unknown> | null }>) {
  const declarations = parseManifestDeclarations(detail?.manifestDeclarations);

  if (!declarations) {
    return (
      <div className="space-y-1 rounded border border-gray-800 p-2" data-testid="provision-declarations-preview" data-state="unread">
        <p className="text-xs text-gray-400">App scopes and dependencies</p>
        <p className="text-xs text-gray-500">
          No <span className="font-mono">imajin.app.json</span> declarations could be read for this proposal. Approving
          registers none — provisioning stops if the manifest declares any.
        </p>
      </div>
    );
  }

  const { providesScopes, dependsOn, emittableEvents } = declarations;
  const isEmpty = providesScopes.length === 0 && dependsOn.length === 0 && emittableEvents.length === 0;

  return (
    <div
      className="space-y-1 rounded border border-gray-800 p-2"
      data-testid="provision-declarations-preview"
      data-state={isEmpty ? 'empty' : 'declared'}
    >
      <p className="text-xs text-gray-400">
        App scopes and dependencies, read from <span className="font-mono">imajin.app.json</span> — approving registers
        exactly this list, nothing beyond it.
      </p>
      {isEmpty ? (
        <p className="text-xs text-gray-500">Declares no scopes of its own, no dependencies, and no events it may emit.</p>
      ) : (
        <>
          <Row label="Provides scopes">
            <span className="font-mono" data-testid="provision-declarations-provides">
              {providesScopes.join(', ') || '\u2014'}
            </span>
          </Row>
          <div className="text-xs text-gray-500" data-testid="provision-declarations-depends">
            <span className="uppercase tracking-wide mr-2">Depends on</span>
            {dependsOn.length === 0 ? (
              '\u2014'
            ) : (
              <ul className="mt-1 space-y-0.5">
                {dependsOn.map((dep) => (
                  <li key={dep.aud} data-testid="provision-declarations-dependency">
                    <span className="font-mono text-gray-300">{dep.aud}</span>
                    <span className="mx-1">→</span>
                    <span className="font-mono">{dep.scopes.join(', ')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Row label="May emit events (notify and audit only)">
            <span className="font-mono" data-testid="provision-declarations-emits">
              {emittableEvents.join(', ') || '\u2014'}
            </span>
          </Row>
        </>
      )}
    </div>
  );
}
