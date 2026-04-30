'use client';

import { useState } from 'react';
import { Avatar } from './Avatar';
import type { MemberEntry } from '../lib/profile-data';

interface MemberSectionProps {
  memberCount: number;
  topMembers: MemberEntry[];
  children: React.ReactNode;
}

export function MemberSection({ memberCount, topMembers, children }: MemberSectionProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300">
          👥 Members
          <span className="ml-1.5 text-gray-500 font-normal">({memberCount})</span>
        </h2>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-xs text-[#F59E0B] hover:underline"
        >
          {expanded ? 'Collapse ↑' : 'View all →'}
        </button>
      </div>

      {/* Avatar row of owners/admins */}
      {topMembers.length > 0 && (
        <div className="flex items-center justify-center gap-1 mb-3">
          {topMembers.map((m) => (
            <a
              key={m.did}
              href={`/profile/${m.handle ?? m.did}`}
              title={m.displayName}
              className="shrink-0"
            >
              <Avatar avatar={m.avatar} displayName={m.displayName} size="sm" />
            </a>
          ))}
        </div>
      )}

      {/* Full member list — hidden until expanded */}
      <div className={expanded ? 'block' : 'hidden'}>{children}</div>
    </div>
  );
}
