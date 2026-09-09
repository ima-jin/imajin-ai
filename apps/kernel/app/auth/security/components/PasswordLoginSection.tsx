'use client';

/**
 * Password login (stored key) section of account security settings (#2119).
 * Purely presentational: all state and handlers live in the parent page and
 * are passed in as props, so this stays a plain function of its arguments
 * (S6478 — no props/state captured from module scope).
 */
export default function PasswordLoginSection({
  hasStoredKey,
  hasMfa,
  showPasswordChange,
  showPasswordReset,
  showPasswordSetup,
  currentPassword,
  password,
  confirmPassword,
  actionLoading,
  onOpenChange,
  onOpenSetup,
  onSwitchToReset,
  onCancelChange,
  onCancelReset,
  onCancelSetup,
  setCurrentPassword,
  setPassword,
  setConfirmPassword,
  handlePasswordChange,
  handlePasswordReset,
  handlePasswordSetup,
}: Readonly<{
  hasStoredKey: boolean;
  hasMfa: boolean;
  showPasswordChange: boolean;
  showPasswordReset: boolean;
  showPasswordSetup: boolean;
  currentPassword: string;
  password: string;
  confirmPassword: string;
  actionLoading: string;
  onOpenChange: () => void;
  onOpenSetup: () => void;
  onSwitchToReset: () => void;
  onCancelChange: () => void;
  onCancelReset: () => void;
  onCancelSetup: () => void;
  setCurrentPassword: (value: string) => void;
  setPassword: (value: string) => void;
  setConfirmPassword: (value: string) => void;
  handlePasswordChange: (e: React.FormEvent) => void;
  handlePasswordReset: (e: React.FormEvent) => void;
  handlePasswordSetup: (e: React.FormEvent) => void;
}>) {
  return (
    <div className="py-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-white font-medium">Password login</p>
          <p className="text-sm text-gray-400 mt-1">
            {hasStoredKey
              ? 'Your encrypted key is stored. Use your password to log in on this device.'
              : 'Store an encrypted copy of your key to log in with a password.'}
          </p>
          {hasStoredKey && !hasMfa && (
            <p className="text-xs text-blue-400 mt-2">We recommend setting up an additional MFA method (authenticator app or email code) to protect your account.</p>
          )}
        </div>
        <div className="ml-4 flex flex-col items-end gap-2">
          {hasStoredKey ? (
            <>
              <span className="px-2 py-1 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Active</span>
              <button type="button"
                onClick={onOpenChange}
                className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition"
              >
                Change password
              </button>
            </>
          ) : (
            <>
              <span className="px-2 py-1 text-xs bg-gray-800 border border-gray-700 rounded text-gray-400 whitespace-nowrap">Not set up</span>
              <button type="button"
                onClick={onOpenSetup}
                className="text-sm px-3 py-1 bg-[#F59E0B] text-black rounded hover:bg-[#D97706] transition"
              >
                Set up password
              </button>
            </>
          )}
        </div>
      </div>

      {/* Change password flow (requires current password) */}
      {showPasswordChange && hasStoredKey && (
        <div className="mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg">
          <h3 className="text-white font-medium mb-2">Change password</h3>
          <p className="text-sm text-gray-400 mb-4">
            Enter your current password to verify, then choose a new one.
          </p>
          <form onSubmit={handlePasswordChange} className="space-y-3">
            <input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="Current password"
              autoFocus
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="New password"
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!currentPassword || !password || !confirmPassword || actionLoading === 'password-change'}
                className="flex-1 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium disabled:opacity-50"
              >
                {actionLoading === 'password-change' ? 'Changing…' : 'Change password'}
              </button>
            </div>
          </form>
          <div className="mt-3 flex items-center justify-between">
            <button type="button"
              onClick={onCancelChange}
              className="text-sm text-gray-500 hover:text-gray-300 transition"
            >
              Cancel
            </button>
            <button type="button"
              onClick={onSwitchToReset}
              className="text-sm text-amber-500 hover:text-amber-400 transition"
            >
              Forgot password?
            </button>
          </div>
        </div>
      )}

      {/* Reset password flow (no current password — uses device-local key) */}
      {showPasswordReset && hasStoredKey && (
        <div className="mt-4 p-4 bg-amber-900/10 border border-amber-700/50 rounded-lg">
          <h3 className="text-white font-medium mb-2">Reset password from this device</h3>
          <p className="text-sm text-gray-400 mb-2">
            Your key is present in this browser, so you can set a new password without the old one.
          </p>
          <p className="text-xs text-amber-400 mb-4">
            ⚠️ This works because your device already has your private key. It&apos;s no different from re-running initial setup.
          </p>
          <form onSubmit={handlePasswordReset} className="space-y-3">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="New password"
              autoFocus
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!password || !confirmPassword || actionLoading === 'password-reset'}
                className="flex-1 py-2 bg-amber-600 text-black rounded-lg hover:bg-amber-500 transition font-medium disabled:opacity-50"
              >
                {actionLoading === 'password-reset' ? 'Resetting…' : 'Reset password'}
              </button>
            </div>
          </form>
          <button type="button"
            onClick={onCancelReset}
            className="mt-3 text-sm text-gray-500 hover:text-gray-300 transition"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Password setup flow (first time) */}
      {showPasswordSetup && !hasStoredKey && (
        <div className="mt-4 p-4 bg-gray-900 border border-gray-700 rounded-lg">
          <h3 className="text-white font-medium mb-2">Set up password login</h3>
          <p className="text-sm text-gray-400 mb-4">
            Your private key will be encrypted in your browser using this password and stored securely.
            Choose a strong password — it cannot be recovered if lost.
          </p>
          <form onSubmit={handlePasswordSetup} className="space-y-3">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="New password"
              autoFocus
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Confirm password"
              className="w-full px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-[#F59E0B] focus:border-transparent"
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!password || !confirmPassword || actionLoading === 'password-setup'}
                className="flex-1 py-2 bg-[#F59E0B] text-black rounded-lg hover:bg-[#D97706] transition font-medium disabled:opacity-50"
              >
                {actionLoading === 'password-setup' ? 'Encrypting…' : 'Enable password login'}
              </button>
            </div>
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
