'use client';

import { useState, useEffect } from 'react';

export type NameDisplayPolicy = 'real_name' | 'handle' | 'anonymous' | 'attendee_choice';
export type DisplayPref = 'real_name' | 'handle' | 'anonymous';

interface NameDisplaySelectorProps {
  policy: NameDisplayPolicy;
  storageKey: string;
  onChange?: (pref: DisplayPref) => void;
}

export function NameDisplaySelector({ policy, storageKey, onChange }: Readonly<NameDisplaySelectorProps>) {
  const [pref, setPref] = useState<DisplayPref>('handle');

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    if (stored && ['real_name', 'handle', 'anonymous'].includes(stored)) {
      setPref(stored as DisplayPref);
    }
  }, [storageKey]);

  if (policy !== 'attendee_choice') return null;

  const handleChange = (value: DisplayPref) => {
    setPref(value);
    localStorage.setItem(storageKey, value);
    onChange?.(value);
  };

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-gray-400">Show me as:</span>
      <select
        value={pref}
        onChange={(e) => handleChange(e.target.value as DisplayPref)}
        className="text-xs bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-orange-500"
      >
        <option value="real_name">Real name</option>
        <option value="handle">@handle</option>
        <option value="anonymous">Anonymous</option>
      </select>
    </div>
  );
}
