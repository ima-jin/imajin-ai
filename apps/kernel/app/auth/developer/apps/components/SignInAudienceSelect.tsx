'use client';

import { APP_SIGN_IN_AUDIENCES, APP_SIGN_IN_AUDIENCE_DESCRIPTIONS, isAppSignInAudience, type AppSignInAudience } from '@/src/lib/apps/sign-in-audience';

export default function SignInAudienceSelect({ id, value, onChange, disabled }: Readonly<{
  id: string;
  value: AppSignInAudience;
  onChange: (value: AppSignInAudience) => void;
  disabled?: boolean;
}>) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
        Sign-in audience
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={event => { if (isAppSignInAudience(event.target.value)) onChange(event.target.value); }}
        aria-describedby={`${id}-description`}
        className="w-full bg-surface-input border border-zinc-700 px-3 py-2.5 text-zinc-100 focus:outline-none focus:border-violet-500 text-sm"
      >
        {APP_SIGN_IN_AUDIENCES.map(audience => <option key={audience} value={audience}>{audience === 'members' ? 'Members only (default)' : 'Anyone signed in'}</option>)}
      </select>
      <p id={`${id}-description`} className="mt-2 text-xs text-zinc-400">
        {APP_SIGN_IN_AUDIENCE_DESCRIPTIONS[value]} This does not list the app publicly or grant organization membership.
      </p>
    </div>
  );
}
