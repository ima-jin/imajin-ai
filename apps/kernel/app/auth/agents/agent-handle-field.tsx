'use client';

import { useCallback } from 'react';
import { agentHandlePrefix, agentSuffixError, composeAgentHandle } from '@/src/lib/auth/agent-handle';

export default function AgentHandleField({ id, ownerHandle, suffix, onChange, focusOnMount = false }: Readonly<{
  id: string;
  ownerHandle: string | null | undefined;
  suffix: string;
  onChange: (value: string) => void;
  focusOnMount?: boolean;
}>) {
  const prefix = agentHandlePrefix(ownerHandle);
  const error = agentSuffixError(ownerHandle, suffix);
  const fullHandle = composeAgentHandle(ownerHandle, suffix);
  const focusRef = useCallback((element: HTMLInputElement | null) => {
    if (focusOnMount) element?.focus();
  }, [focusOnMount]);
  return (
    <div>
      <label htmlFor={id} className="block text-sm text-gray-400 mb-1">{prefix ? 'Suffix (optional)' : 'Handle'}</label>
      <div className="flex items-center gap-2">
        {prefix && <span className="text-sm text-gray-500 shrink-0">@{prefix}</span>}
        <input id={id} type="text" value={suffix}
          onChange={event => onChange(event.target.value.toLowerCase().replaceAll(/[^a-z0-9_-]/g, ''))}
          placeholder={prefix ? 'travel' : 'travel-agent'} aria-describedby={`${id}-help`} ref={focusRef}
          className="flex-1 min-w-0 px-4 py-2 border border-gray-700 rounded-lg bg-black text-white focus:ring-2 focus:ring-amber-500 focus:border-transparent" />
      </div>
      <p id={`${id}-help`} className="text-xs text-gray-600 mt-1">
        Lowercase letters, numbers, underscores, and hyphens only. The full handle must be 3-64 characters.
        {prefix && ` Leave blank for @${prefix}; a suffix adds a hyphen, e.g. @${prefix}-travel.`}
      </p>
      {suffix && error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {!error && <p className="text-sm text-gray-400">Handle: @{fullHandle}</p>}
    </div>
  );
}
