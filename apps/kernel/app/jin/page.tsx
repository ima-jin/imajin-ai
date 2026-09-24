'use client';

import { UsageFeedPanel } from './usage-feed-panel';
import { OperatorApprovalsPanel } from './operator-approvals-panel';
import { VaultKeysPanel } from './vault-keys-panel';
import { AccessBearersPanel } from './access-bearers-panel';
import { GrantsPanel } from './grants-panel';
import { PushSubscribeButton } from './push-subscribe-button';

// ─── Main page ────────────────────────────────────────────────────────────────
//
// #2293: the pre-#2059 legacy GitHub confirm rail (an inline proposal table
// backed by `GET /github/api/proposals` + `POST/DELETE /github/api/confirm/
// [proposalId]`) that used to render here has been folded into
// OperatorApprovalsPanel below — GitHub write proposals now appear as
// `source: 'github'` cards on the single typed operator-approvals queue,
// same decide route, same operator countersign, same fan-out as every other
// kind. See `operator-approvals-panel.tsx`'s `github` renderer and
// `src/lib/github/approvals-execution.ts`.

export default function JinPage() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl font-bold text-amber-500">人</span>
          <div>
            <h1 className="text-base font-semibold leading-tight">/jin</h1>
            <p className="text-xs text-gray-500">Pending proposals — human approval surface</p>
          </div>
        </div>
        {/* #2291 — phone push path: install-to-home-screen PWA + web-push
            opt-in. Renders nothing for a non-operator or unsupported browser. */}
        <PushSubscribeButton />
      </header>

      <main className="px-6 py-4">
        {/* Vault key cards (#2247) — mint/grant/rotate/revoke as signed
            canvas proposals; renders nothing for a non-admin. Rendered
            ABOVE the operator-approvals panel so a freshly-raised vault
            proposal's confirm card appears directly below it. */}
        <VaultKeysPanel />

        {/* Delegate-grant bearers (#2252) — knock/manage self-service,
            visible to any signed-in identity; renders nothing when signed
            out. Rendered ABOVE the operator-approvals panel so a freshly
            raised knock's confirm card appears directly below it, same
            placement convention as VaultKeysPanel above. */}
        <AccessBearersPanel />

        {/* Operator approvals (#2059, generalized #2152, GitHub folded in
            #2293) — the single typed confirm queue: gateway restart/config,
            vault, access, skill-workshop, gateway-exec, and github
            proposals all ride this one rail. Visible only to the node
            operator; renders nothing otherwise. */}
        <OperatorApprovalsPanel />

        {/* Grants lane (#2292) — standing-authority projection across every
            grant source, one-tap revoke; operator-gated, renders nothing
            otherwise. Rendered below OperatorApprovalsPanel so a freshly
            raised revoke/decision surfaces above this read-only lane. */}
        <GrantsPanel />

        {/* Live per-turn agent usage feed (#1864) — a second panel on this
            kernel ops page, alongside the confirm-rail proposals above. */}
        <UsageFeedPanel />
      </main>
    </div>
  );
}
