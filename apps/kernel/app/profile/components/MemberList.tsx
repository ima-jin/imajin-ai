import { getMembersByRole } from '../lib/profile-data';
import { Avatar } from './Avatar';

interface MemberListProps {
  identityDid: string;
  roleFilter?: string;
  grouped?: boolean;
  showCount?: boolean;
  title?: string;
}

const ROLE_HEADERS: Record<string, string> = {
  owner: '👑 Owners',
  admin: '🛡️ Admins',
  member: '👥 Members',
  maintainer: '🔧 Maintainers',
};

export async function MemberList({
  identityDid,
  roleFilter,
  grouped = false,
  showCount = false,
  title = 'Members',
}: MemberListProps) {
  const allMembers = await getMembersByRole(identityDid);
  const members = roleFilter
    ? allMembers.filter((m) => m.role === roleFilter)
    : allMembers;

  const sectionTitle = roleFilter
    ? (ROLE_HEADERS[roleFilter] ?? `${roleFilter}s`)
    : title;

  if (members.length === 0) {
    return (
      <div className="mb-6 bg-surface-surface/50 border border-white/10 p-4 text-center">
        <p className="text-xs text-secondary">No members yet</p>
      </div>
    );
  }

  if (grouped && !roleFilter) {
    const byRole: Record<string, typeof members> = {};
    for (const m of members) {
      if (!byRole[m.role]) byRole[m.role] = [];
      byRole[m.role].push(m);
    }
    const roleOrder = ['owner', 'admin', 'maintainer', 'member'];
    const sortedRoles = [
      ...roleOrder.filter((r) => byRole[r]),
      ...Object.keys(byRole).filter((r) => !roleOrder.includes(r)),
    ];

    return (
      <div className="mb-6 space-y-4">
        {sortedRoles.map((role) => (
          <div key={role} className="bg-surface-surface/50 border border-white/10 p-4">
            <p className="text-xs text-secondary mb-3 text-center">
              {ROLE_HEADERS[role] ?? role}
              {showCount && (
                <span className="ml-1 text-muted">({byRole[role].length})</span>
              )}
            </p>
            <div className="space-y-2">
              {byRole[role].map((m) => (
                <MemberRow key={m.did} member={m} />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="mb-6 bg-surface-surface/50 border border-white/10 p-4">
      <p className="text-xs text-secondary mb-3 text-center">
        {sectionTitle}
        {showCount && (
          <span className="ml-1 text-muted">({members.length})</span>
        )}
      </p>
      <div className="space-y-2">
        {members.map((m) => (
          <MemberRow key={m.did} member={m} />
        ))}
      </div>
    </div>
  );
}

function MemberRow({ member }: { member: { did: string; displayName: string; handle?: string; avatar?: string } }) {
  const initials = member.displayName
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="flex items-center gap-3">
      <div className="flex-shrink-0">
        {member.avatar ? (
          <Avatar avatar={member.avatar} displayName={member.displayName} size="sm" />
        ) : (
          <div className="w-8 h-8 rounded-full flex items-center justify-center bg-surface-elevated border border-white/10 text-xs font-medium text-secondary">
            {initials || '?'}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-primary font-medium truncate">{member.displayName}</p>
        {member.handle && (
          <p className="text-xs text-secondary truncate">@{member.handle}</p>
        )}
      </div>
    </div>
  );
}
