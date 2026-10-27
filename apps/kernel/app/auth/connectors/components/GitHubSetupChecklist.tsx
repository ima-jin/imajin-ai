'use client';

import { useState } from 'react';

export function GitHubSetupChecklist({ flow, callbackUrl }: Readonly<{
  flow: 'device' | 'authorization_code';
  callbackUrl: string;
}>) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const device = flow === 'device';

  async function copyCallback() {
    try {
      await navigator.clipboard.writeText(callbackUrl);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <section aria-label="GitHub OAuth App setup" className="space-y-4 border border-white/10 p-4">
      <h4 className="font-semibold text-white">
        {device ? 'Device flow setup — recommended for new users' : 'Authorization-code setup'}
      </h4>
      <ol className="space-y-5">
        <li className="min-w-0 space-y-2 border-t border-white/10 pt-3">
          <h5 className="font-medium text-white">1. Create your own GitHub OAuth App</h5>
          <p className="text-sm text-gray-300">
            Open{' '}
            <a href="https://github.com/settings/applications/new" target="_blank" rel="noopener noreferrer"
              className="text-amber-300 underline">New OAuth App</a>
            {' '}in GitHub. Enter an application name and your homepage URL.
          </p>
        </li>
        <li className="min-w-0 space-y-2 border-t border-white/10 pt-3">
          <h5 className="font-medium text-white">2. Paste the Authorization callback URL</h5>
          <code className="block break-all text-sm text-amber-300">{callbackUrl}</code>
          <button type="button" onClick={() => { void copyCallback(); }} disabled={!callbackUrl}
            className="border border-white/20 px-3 py-2 text-sm text-gray-200 hover:bg-white/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400">
            Copy callback URL
          </button>
          <output className="block text-sm text-gray-300">
            {copyState === 'copied' && 'Copied callback URL.'}
            {copyState === 'failed' && 'Could not copy. Select and copy the callback URL above.'}
          </output>
          {device ? (
            <p className="text-sm text-gray-300">Device flow doesn&apos;t use this URL, but GitHub requires it to register the app.</p>
          ) : (
            <p className="text-sm text-gray-300">GitHub redirects back here after authorization. Keep the Redirect URI below identical to this URL.</p>
          )}
        </li>
        <li className="min-w-0 space-y-2 border-t border-white/10 pt-3">
          <h5 className="font-medium text-white">
            {device ? '3. Enable Device Flow and register' : '3. Register and generate a client secret'}
          </h5>
          <p className="text-sm text-gray-300">
            {device ? (
              <>Check <strong>Enable Device Flow</strong> before registering the application.</>
            ) : (
              <>Register the application, then generate a client secret on its settings page.</>
            )}
          </p>
        </li>
        <li className="min-w-0 space-y-2 border-t border-white/10 pt-3">
          <h5 className="font-medium text-white">4. Save config here, then connect</h5>
          <p className="text-sm text-gray-300">
            {device
              ? 'Paste the Client ID below and save. Choose Connect with device flow, then enter the code at GitHub and approve. No client secret is needed.'
              : 'Paste the Client ID and client secret below, confirm the Redirect URI, and save. Choose Connect GitHub Account and approve on GitHub.'}
          </p>
        </li>
      </ol>
    </section>
  );
}

export function GitHubOrgAccessNote({ clientId }: Readonly<{ clientId?: string | null }>) {
  const href = clientId
    ? `https://github.com/settings/connections/applications/${encodeURIComponent(clientId)}`
    : 'https://github.com/settings/connections/applications';

  return (
    <aside aria-label="GitHub organization access" className="mt-3 space-y-2 border border-white/10 p-4 text-sm text-gray-300">
      <h4 className="font-medium text-white">Don&apos;t see an org?</h4>
      <p>
        Open{' '}
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-amber-300 underline">
          {clientId ? 'your GitHub app’s organization access' : 'GitHub Authorized OAuth Apps and select your app'}
        </a>
        {' '}→ <strong>Organization access</strong> → <strong>Request</strong>.
      </p>
      <p>
        An org owner then approves under org <strong>Settings</strong> → <strong>Third-party Access</strong>
        {' '}→ <strong>OAuth app policy</strong>. The app appears there after you request access.
      </p>
    </aside>
  );
}
