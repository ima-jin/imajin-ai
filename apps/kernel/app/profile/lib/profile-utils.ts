import { buildPublicUrl } from '@imajin/config';

export function getScopeEmoji(scope: string, subtype: string | null): string {
  if (scope === 'actor') {
    const map: Record<string, string> = { human: '👤', agent: '🤖', device: '📱', presence: '🟠' };
    return map[subtype ?? 'human'] ?? '👤';
  }
  const map: Record<string, string> = { business: '🏢', family: '👨‍👩‍👧‍👦', community: '🌐' };
  return map[scope] ?? '👤';
}

export function getScopeLabel(scope: string, subtype: string | null): string {
  if (scope === 'actor') {
    const map: Record<string, string> = {
      human: '👤 Human',
      agent: '🤖 Agent',
      device: '📱 Device',
      presence: '🟠 Presence',
    };
    return map[subtype ?? 'human'] ?? '👤 Human';
  }
  const map: Record<string, string> = {
    business: '🏢 Business',
    family: '👨‍👩‍👧‍👦 Family',
    community: '🌐 Community',
  };
  return map[scope] ?? scope;
}

export function buildServiceUrl(service: string): string {
  return buildPublicUrl(service);
}

export function formatMemberSince(createdAt: string): string {
  return new Date(createdAt).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  });
}
