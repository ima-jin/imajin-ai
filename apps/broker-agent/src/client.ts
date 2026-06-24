/**
 * KernelClient — thin HTTP wrapper for broker-agent → kernel API calls.
 *
 * All calls authenticate as the bot app (Bearer <app-service-token>).
 * Calls that act on behalf of a user include X-Acting-For: <userDid>.
 *
 * The token is obtained lazily from the TokenProvider, auto-refreshed near
 * expiry, and retried once on 401 (covers the edge case where the cached token
 * expires between the TTL threshold and the actual expiry).
 */

import type { TokenProvider } from './token.js';

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
  private readonly tokenProvider: TokenProvider;

  constructor(baseUrl: string, tokenProvider: TokenProvider) {
    this.baseUrl       = baseUrl.replace(/\/$/, '');
    this.tokenProvider = tokenProvider;
  }

  private async headers(userDid?: string): Promise<Record<string, string>> {
    const token = await this.tokenProvider.getToken();
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
    if (userDid) h['X-Acting-For'] = userDid;
    return h;
  }

  private async fetch<T>(
    path: string,
    init: Omit<RequestInit, 'headers'> & { userDid?: string } = {}
  ): Promise<T> {
    const { userDid, ...rest } = init;
    const doRequest = async () => fetch(`${this.baseUrl}${path}`, {
      ...rest,
      headers: await this.headers(userDid),
    });

    let res = await doRequest();

    // Retry once on 401 — the cached token may have just expired
    if (res.status === 401) {
      this.tokenProvider.invalidate();
      res = await doRequest();
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
      throw new Error(`Kernel API ${path} \u2192 ${res.status}: ${body.error ?? res.statusText}`);
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
      userDid,
      body: JSON.stringify(params),
    });
  }

  /** List a user's own live availability intents. */
  async listIntentions(userDid: string): Promise<{ intents: Record<string, unknown>[] }> {
    return this.fetch('/calendar/api/availability', { userDid });
  }

  /** Cancel an availability intent. */
  async cancelIntention(userDid: string, intentionId: string): Promise<{ cancelled: boolean }> {
    return this.fetch(`/calendar/api/availability/${encodeURIComponent(intentionId)}`, {
      method: 'DELETE',
      userDid,
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
