/**
 * KernelClient — thin HTTP wrapper for broker-agent → kernel API calls.
 *
 * All calls authenticate as the bot app (Bearer <BOT_APP_TOKEN>).
 * Calls that act on behalf of a user include X-Acting-For: <userDid>.
 */

export interface IntentionParams {
  intent: string;
  activityTags?: string[];
  sensitiveTags?: string[];
  reach?: 'favourites' | 'one_degree' | 'strangers';
  window?: 'today' | 'tonight' | 'this_weekend' | 'this_week' | 'next_week';
  startsAt?: string;
  endsAt?: string;
  expiresAt?: string;
}

export interface PendingNotification {
  id: string;
  matchId: string;
  recipientDid: string;
  channel: string;
  channelUid: string | null;
  otherDid: string | null;
  overlapTags: string[];
  isSensitive: boolean;
  deliveryPolicy: 'named_nudge' | 'staged' | 'sensitive_staged';
  createdAt: string;
}

export class KernelClient {
  private readonly baseUrl: string;
  private readonly appToken: string;

  constructor(baseUrl: string, appToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.appToken = appToken;
  }

  private headers(userDid?: string): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.appToken}`,
    };
    if (userDid) h['X-Acting-For'] = userDid;
    return h;
  }

  private async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init.headers as Record<string, string> ?? {}) },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(`Kernel API ${path} → ${res.status}: ${(err as { error?: string }).error ?? res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  /** Resolve a Telegram chat_id to an Imajin DID. Returns null if not linked. */
  async resolveChannelLink(channelUid: string): Promise<{ did: string; scopes: string[] } | null> {
    try {
      return await this.fetch<{ did: string; scopes: string[] }>(
        `/auth/api/channel-link/resolve?channel=telegram&channelUid=${encodeURIComponent(channelUid)}`
      );
    } catch {
      return null;
    }
  }

  /** Start a channel linking flow. Returns the one-time URL to send the user. */
  async startChannelLink(channelUid: string): Promise<{ url: string; expiresAt: string }> {
    return this.fetch('/auth/api/channel-link', {
      method: 'POST',
      body: JSON.stringify({
        channel: 'telegram',
        channelUid,
        requestedScopes: ['availability:read', 'availability:write'],
      }),
    });
  }

  /** Set an availability intent on behalf of a user. */
  async setIntention(userDid: string, params: IntentionParams): Promise<{ intent: Record<string, unknown> }> {
    return this.fetch('/calendar/api/availability', {
      method: 'POST',
      headers: this.headers(userDid),
      body: JSON.stringify(params),
    });
  }

  /** List a user's own live availability intents. */
  async listIntentions(userDid: string): Promise<{ intents: Record<string, unknown>[] }> {
    return this.fetch('/calendar/api/availability', {
      headers: this.headers(userDid),
    });
  }

  /** Cancel an availability intent. */
  async cancelIntention(userDid: string, intentionId: string): Promise<{ cancelled: boolean }> {
    return this.fetch(`/calendar/api/availability/${encodeURIComponent(intentionId)}`, {
      method: 'DELETE',
      headers: this.headers(userDid),
    });
  }

  /** Get pending match notifications for this bot's linked users. */
  async getPendingMatches(): Promise<{ notifications: PendingNotification[] }> {
    return this.fetch('/calendar/api/availability/matches');
  }

  /** Mark match notifications as delivered. */
  async markMatchesDelivered(ids: string[]): Promise<{ marked: number }> {
    return this.fetch('/calendar/api/availability/matches', {
      method: 'PATCH',
      body: JSON.stringify({ ids }),
    });
  }
}
