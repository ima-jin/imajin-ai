'use client';

/**
 * Email code MFA section of account security settings (#2119).
 * Purely presentational: all state and handlers live in the parent page and
 * are passed in as props (S6478 — no props/state captured from module scope).
 */
export default function EmailMfaSection({
  hasEmailMfa,
  showEmailSetup,
  emailCode,
  actionLoading,
  onStartSetup,
  onDisable,
  onCancelSetup,
  setEmailCode,
  handleVerifyEmailSetup,
}: Readonly<{
  hasEmailMfa: boolean;
  showEmailSetup: boolean;
  emailCode: string;
  actionLoading: string;
  onStartSetup: () => void;
  onDisable: () => void;
  onCancelSetup: () => void;
  setEmailCode: (value: string) => void;
  handleVerifyEmailSetup: (e: React.FormEvent) => void;
}>) {
  return (
    <div className="py-4 border-b border-gray-800">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-white font-medium">Email code</p>
          <p className="text-sm text-gray-400 mt-1">Receive a one-time code via email as a second factor.</p>
        </div>
        <div className="ml-4 flex flex-col items-end gap-2">
          {hasEmailMfa ? (
            <span className="px-2 py-1 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Active</span>
          ) : (
            <span className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 whitespace-nowrap">Not set up</span>
          )}
          {hasEmailMfa ? (
            <button type="button"
              onClick={onDisable}
              disabled={actionLoading === 'email-disable'}
              className="text-sm px-3 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition disabled:opacity-50"
            >
              {actionLoading === 'email-disable' ? 'Disabling…' : 'Disable'}
            </button>
          ) : (
            <button type="button"
              onClick={onStartSetup}
              disabled={actionLoading === 'email-setup'}
              className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition disabled:opacity-50"
            >
              {actionLoading === 'email-setup' ? 'Sending…' : 'Enable'}
            </button>
          )}
        </div>
      </div>

      {/* Email MFA setup flow */}
      {showEmailSetup && !hasEmailMfa && (
        <div className="mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg">
          <h3 className="text-white font-medium mb-2">Verify your email</h3>
          <p className="text-sm text-gray-400 mb-4">A 6-digit code was sent to your registered email address. Enter it below to activate email MFA.</p>
          <form onSubmit={handleVerifyEmailSetup} className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={emailCode}
              onChange={e => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              autoFocus
              className="flex-1 px-4 py-2 border border-gray-700 rounded-lg bg-black text-white text-center font-mono tracking-widest focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <button
              type="submit"
              disabled={emailCode.length !== 6 || actionLoading === 'email-verify'}
              className="px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium disabled:opacity-50"
            >
              {actionLoading === 'email-verify' ? 'Verifying…' : 'Confirm'}
            </button>
          </form>
          <button type="button"
            onClick={onCancelSetup}
            className="mt-3 text-sm text-gray-500 hover:text-gray-300 transition"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
