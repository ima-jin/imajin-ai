'use client';

import {
  APP_VISIBILITIES,
  APP_VISIBILITY_DESCRIPTIONS,
  isAppVisibility,
  type AppVisibility,
} from '@/src/lib/apps/visibility';

export default function VisibilitySelect({ id, value, onChange }: Readonly<{
  id: string;
  value: AppVisibility;
  onChange: (value: AppVisibility) => void;
}>) {
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-1.5">
        App visibility
      </label>
      <select
        id={id}
        value={value}
        onChange={event => {
          if (isAppVisibility(event.target.value)) onChange(event.target.value);
        }}
        aria-describedby={`${id}-description ${id}-web`}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2.5 text-white focus:outline-none focus:border-amber-500 text-sm"
      >
        {APP_VISIBILITIES.map(visibility => (
          <option key={visibility} value={visibility}>
            {visibility.charAt(0).toUpperCase() + visibility.slice(1)} — {APP_VISIBILITY_DESCRIPTIONS[visibility]}
          </option>
        ))}
      </select>
      <p id={`${id}-description`} className="mt-2 text-xs text-zinc-400">{APP_VISIBILITY_DESCRIPTIONS[value]}</p>
      <p id={`${id}-web`} className="mt-1 text-xs text-zinc-400">
        This controls discovery, not sign-in audience or web access. Public web pages remain public.
      </p>
    </div>
  );
}
