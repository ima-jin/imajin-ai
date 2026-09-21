'use client';

import { ConnectionPicker } from '@imajin/ui';
import type { RecipientInviteDraft, SelectedConnection } from '../lib/types';

export type RecipientMode = 'connection' | 'invite';

interface Props {
  mode: RecipientMode;
  onModeChange: (mode: RecipientMode) => void;
  selectedConnection: SelectedConnection | null;
  onSelectConnection: (connection: SelectedConnection | null) => void;
  invite: RecipientInviteDraft;
  onInviteChange: (invite: RecipientInviteDraft) => void;
}

const TAB_BASE = 'flex-1 px-3 py-2 text-sm font-medium rounded-lg border transition-colors';
const TAB_ACTIVE = 'border-amber-500/50 bg-amber-500/10 text-amber-300';
const TAB_INACTIVE = 'border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-200';

function connectionLabel(connection: SelectedConnection): string {
  if (connection.name) return connection.name;
  if (connection.handle) return `@${connection.handle}`;
  return `${connection.did.slice(0, 20)}…`;
}

/**
 * Recipient picker for the create flow (#2211): EITHER an existing
 * connection (searched via `ConnectionPicker`, matching `service.ts`'s
 * `recipient_did` path — must be a DID the issuer already has a
 * connection with) OR a fresh "invite new" counterparty (`recipient_invite`,
 * #2210) — email, delivery, optional note.
 */
export default function RecipientPicker({
  mode,
  onModeChange,
  selectedConnection,
  onSelectConnection,
  invite,
  onInviteChange,
}: Readonly<Props>) {
  return (
    <div className="space-y-3">
      <div className="flex gap-2" role="tablist" aria-label="Recipient type">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'connection'}
          onClick={() => onModeChange('connection')}
          className={`${TAB_BASE} ${mode === 'connection' ? TAB_ACTIVE : TAB_INACTIVE}`}
        >
          Existing connection
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'invite'}
          onClick={() => onModeChange('invite')}
          className={`${TAB_BASE} ${mode === 'invite' ? TAB_ACTIVE : TAB_INACTIVE}`}
        >
          Invite new
        </button>
      </div>

      {mode === 'connection' &&
        (selectedConnection ? (
          <div className="flex items-center gap-2 px-3 py-2 bg-black/40 rounded-lg">
            <span className="text-sm text-zinc-300">{connectionLabel(selectedConnection)}</span>
            <span className="text-xs text-zinc-600 font-mono truncate">{selectedConnection.did}</span>
            <button
              type="button"
              onClick={() => onSelectConnection(null)}
              className="ml-auto text-zinc-500 hover:text-red-400 text-xs"
            >
              ✕
            </button>
          </div>
        ) : (
          <ConnectionPicker
            connectionsUrl="/connections/api/connections"
            onSelect={(connection) =>
              onSelectConnection({ did: connection.did, name: connection.name, handle: connection.handle })
            }
            placeholder="Search your connections…"
          />
        ))}

      {mode === 'invite' && (
        <div className="space-y-3">
          <div>
            <label htmlFor="recipient-invite-email" className="block text-xs text-zinc-500 mb-1.5">
              Email
            </label>
            <input
              id="recipient-invite-email"
              type="email"
              value={invite.email}
              onChange={(e) => onInviteChange({ ...invite, email: e.target.value })}
              placeholder="customer@example.com"
              className="w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-amber-500 focus:outline-none"
            />
          </div>
          <fieldset>
            <legend className="block text-xs text-zinc-500 mb-1.5">Delivery</legend>
            <div className="flex gap-4">
              <label htmlFor="recipient-invite-delivery-email" className="flex items-center gap-1.5 text-sm text-zinc-300">
                <input
                  id="recipient-invite-delivery-email"
                  type="radio"
                  name="recipient-invite-delivery"
                  checked={invite.delivery === 'email'}
                  onChange={() => onInviteChange({ ...invite, delivery: 'email' })}
                />
                Email
              </label>
              <label htmlFor="recipient-invite-delivery-link" className="flex items-center gap-1.5 text-sm text-zinc-300">
                <input
                  id="recipient-invite-delivery-link"
                  type="radio"
                  name="recipient-invite-delivery"
                  checked={invite.delivery === 'link'}
                  onChange={() => onInviteChange({ ...invite, delivery: 'link' })}
                />
                Link only
              </label>
            </div>
          </fieldset>
          <div>
            <label htmlFor="recipient-invite-note" className="block text-xs text-zinc-500 mb-1.5">
              Note (optional)
            </label>
            <textarea
              id="recipient-invite-note"
              value={invite.note}
              onChange={(e) => onInviteChange({ ...invite, note: e.target.value })}
              rows={2}
              placeholder="Add a note for the invite"
              className="w-full bg-black border border-zinc-700 rounded-lg p-3 text-sm text-white placeholder-zinc-600 resize-none focus:border-amber-500 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
