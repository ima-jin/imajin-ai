/**
 * startMatchDelivery (#2570). Matches are sent one at a time, notifications
 * without a chat are skipped, a failed send does not stop the rest, and only
 * the matches that were actually delivered are marked delivered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent.js', () => ({ routeMessage: vi.fn() }));

import type { Bot } from 'grammy';
import { startMatchDelivery } from '../bot';
import type { KernelClient, PendingNotification } from '../client';

const notification = (id: string, channelUid: string | null, deliveryPolicy: PendingNotification['deliveryPolicy']) =>
  ({
    id,
    matchId: `m-${id}`,
    recipientDid: 'did:imajin:r',
    channel: 'telegram',
    channelUid,
    otherDid: null,
    overlapTags: [],
    isSensitive: false,
    deliveryPolicy,
    createdAt: '2026-10-05T00:00:00Z',
  }) satisfies PendingNotification;

let timer: NodeJS.Timeout | undefined;

afterEach(() => {
  if (timer) clearInterval(timer);
  vi.restoreAllMocks();
});

describe('startMatchDelivery', () => {
  it('delivers sequentially, skips chat-less matches, tolerates failures, and marks only delivered ids', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const events: string[] = [];
    const sendMessage = vi.fn(async (chatId: string) => {
      events.push(`start-${chatId}`);
      await new Promise((resolve) => setTimeout(resolve, chatId === 'c1' ? 15 : 1));
      if (chatId === 'c2') throw new Error('blocked by user');
      events.push(`end-${chatId}`);
    });
    const markMatchesDelivered = vi.fn(async () => ({ marked: 2 }));
    const kernel = {
      getPendingMatches: vi.fn(async () => ({
        notifications: [
          notification('n1', 'c1', 'named_nudge'),
          notification('n0', null, 'staged'),
          notification('n2', 'c2', 'staged'),
          notification('n3', 'c3', 'sensitive_staged'),
        ],
      })),
      markMatchesDelivered,
    } as unknown as KernelClient;

    timer = startMatchDelivery({ api: { sendMessage } } as unknown as Bot, kernel);
    await vi.waitFor(() => expect(markMatchesDelivered).toHaveBeenCalled());

    expect(events).toEqual(['start-c1', 'end-c1', 'start-c2', 'start-c3', 'end-c3']);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[0][2]).toEqual({ parse_mode: 'Markdown' });
    expect(markMatchesDelivered).toHaveBeenCalledWith(['n1', 'n3']);
  });

  it('does not mark anything delivered when no send succeeds', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sendMessage = vi.fn(async () => {
      throw new Error('nope');
    });
    const markMatchesDelivered = vi.fn();
    const getPendingMatches = vi.fn(async () => ({ notifications: [notification('n1', 'c1', 'staged')] }));

    timer = startMatchDelivery(
      { api: { sendMessage } } as unknown as Bot,
      { getPendingMatches, markMatchesDelivered } as unknown as KernelClient,
    );
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled());
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledTimes(1));

    expect(markMatchesDelivered).not.toHaveBeenCalled();
  });

  it('returns early when there are no pending matches', async () => {
    const sendMessage = vi.fn();
    const getPendingMatches = vi.fn(async () => ({ notifications: [] }));

    timer = startMatchDelivery(
      { api: { sendMessage } } as unknown as Bot,
      { getPendingMatches, markMatchesDelivered: vi.fn() } as unknown as KernelClient,
    );
    await vi.waitFor(() => expect(getPendingMatches).toHaveBeenCalled());

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
