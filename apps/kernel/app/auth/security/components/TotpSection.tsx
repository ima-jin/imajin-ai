'use client';

export interface TotpSetupData {
  secret: string;
  otpauthUrl: string;
  qrCode: string;
}

/**
 * Authenticator app (TOTP) MFA section of account security settings (#2119).
 * Purely presentational: all state and handlers live in the parent page and
 * are passed in as props (S6478 — no props/state captured from module scope).
 */
export default function TotpSection({
  hasTotpEnabled,
  showTotpSetup,
  totpSetup,
  totpCode,
  showTotpDisable,
  totpDisableCode,
  actionLoading,
  onStartSetup,
  onOpenDisable,
  onCancelSetup,
  onCancelDisable,
  setTotpCode,
  setTotpDisableCode,
  handleVerifyTotp,
  handleDisableTotp,
}: Readonly<{
  hasTotpEnabled: boolean;
  showTotpSetup: boolean;
  totpSetup: TotpSetupData | null;
  totpCode: string;
  showTotpDisable: boolean;
  totpDisableCode: string;
  actionLoading: string;
  onStartSetup: () => void;
  onOpenDisable: () => void;
  onCancelSetup: () => void;
  onCancelDisable: () => void;
  setTotpCode: (value: string) => void;
  setTotpDisableCode: (value: string) => void;
  handleVerifyTotp: (e: React.FormEvent) => void;
  handleDisableTotp: (e: React.FormEvent) => void;
}>) {
  return (
    <div className="py-4 border-b border-gray-800">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-white font-medium">Authenticator app (TOTP)</p>
          <p className="text-sm text-gray-400 mt-1">Use an app like Authy or Google Authenticator to generate codes.</p>
        </div>
        <div className="ml-4 flex flex-col items-end gap-2">
          {hasTotpEnabled ? (
            <span className="px-2 py-1 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Active</span>
          ) : (
            <span className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 whitespace-nowrap">Not set up</span>
          )}
          {hasTotpEnabled ? (
            <button type="button"
              onClick={onOpenDisable}
              className="text-sm px-3 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition"
            >
              Remove
            </button>
          ) : (
            <button type="button"
              onClick={onStartSetup}
              disabled={actionLoading === 'totp-setup'}
              className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition disabled:opacity-50"
            >
              {actionLoading === 'totp-setup' ? 'Setting up…' : 'Set up'}
            </button>
          )}
        </div>
      </div>

      {/* TOTP setup flow */}
      {showTotpSetup && totpSetup && (
        <div className="mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg">
          <h3 className="text-white font-medium mb-3">Scan QR code</h3>
          <p className="text-sm text-gray-400 mb-4">Scan this code with your authenticator app, then enter the 6-digit code to confirm.</p>
          <div className="flex justify-center mb-4">
            { }
            <img src={totpSetup.qrCode} alt="TOTP QR Code" className="rounded" width={200} height={200} />
          </div>
          <p className="text-xs text-gray-500 text-center mb-4 font-mono break-all">
            Manual key: {totpSetup.secret}
          </p>
          <form onSubmit={handleVerifyTotp} className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={totpCode}
              onChange={e => setTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              autoFocus
              className="flex-1 px-4 py-2 border border-gray-700 rounded-lg bg-black text-white text-center font-mono tracking-widest focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <button
              type="submit"
              disabled={totpCode.length !== 6 || actionLoading === 'totp-verify'}
              className="px-4 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium disabled:opacity-50"
            >
              {actionLoading === 'totp-verify' ? 'Verifying…' : 'Confirm'}
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

      {/* TOTP disable flow */}
      {showTotpDisable && (
        <div className="mt-4 p-4 bg-red-900/10 border border-red-800/50 rounded-lg">
          <h3 className="text-white font-medium mb-2">Confirm removal</h3>
          <p className="text-sm text-gray-400 mb-4">Enter your current authenticator code to remove TOTP.</p>
          <form onSubmit={handleDisableTotp} className="flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={totpDisableCode}
              onChange={e => setTotpDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              maxLength={6}
              autoFocus
              className="flex-1 px-4 py-2 border border-red-800 rounded-lg bg-black text-white text-center font-mono tracking-widest focus:ring-2 focus:ring-red-600 focus:border-transparent"
            />
            <button
              type="submit"
              disabled={totpDisableCode.length !== 6 || actionLoading === 'totp-disable'}
              className="px-4 py-2 border border-red-700 text-red-400 rounded-lg hover:bg-red-900/30 transition disabled:opacity-50"
            >
              {actionLoading === 'totp-disable' ? 'Removing…' : 'Remove'}
            </button>
          </form>
          <button type="button"
            onClick={onCancelDisable}
            className="mt-3 text-sm text-gray-500 hover:text-gray-300 transition"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
