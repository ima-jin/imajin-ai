import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sealMock, loadMock, whereMock, publishMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  whereMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStore: sealMock, loadAndUnseal: loadMock }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
}));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));

import {
  resolveActiveGrant,
  sealToken,
  postMessage,
  readMessages,
  vaultField,
  DISCORD_CONNECTOR_DID,
} from '../connector';

const OWNER = 'did:imajin:jin';
const CHANNEL_ID = '1234567890';
const BOT_TOKEN = 'Bot.Token.REDACTED';

const MOCK_MESSAGE = {
  id: 'msg_001',
  channel_id: CHANNEL_ID,
  content: 'Hello from Jin',
  timestamp: '2026-07-13T04:00:00.000Z',
  author: { id: 'bot_001', username: 'jin-bot' },
};

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function noGrant() {
  whereMock.mockResolvedValue([]);
}

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  loadMock.mockReset();
  loadMock.mockResolvedValue(BOT_TOKEN);
  whereMock.mockReset();
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── vaultField ────────────────────────────────────────────────────────────────

describe('vaultField', () => {
  it('encodes the ownerDid in the field name for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`discord-bot-token:${OWNER}`);
  });
});

// ── resolveActiveGrant ────────────────────────────────────────────────────────

describe('resolveActiveGrant (#18)', () => {
  it('is true when an active row includes the required scope', async () => {
    grant(['discord:post']);
    expect(await resolveActiveGrant(OWNER, 'discord:post')).toBe(true);
  });

  it('is false when no active row includes the required scope', async () => {
    grant(['other:scope']);
    expect(await resolveActiveGrant(OWNER, 'discord:post')).toBe(false);
  });

  it('is false when there are no rows at all', async () => {
    noGrant();
    expect(await resolveActiveGrant(OWNER, 'discord:post')).toBe(false);
  });
});

// ── sealToken ─────────────────────────────────────────────────────────────────

describe('sealToken (#18)', () => {
  it('seals the token under the per-DID vault field', async () => {
    await sealToken(OWNER, BOT_TOKEN);
    expect(sealMock).toHaveBeenCalledOnce();
    const [field, plaintext] = sealMock.mock.calls[0];
    expect(field).toBe(vaultField(OWNER));
    expect(plaintext).toBe(BOT_TOKEN);
  });
});

// ── postMessage ───────────────────────────────────────────────────────────────

describe('postMessage (#18)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(postMessage(OWNER, CHANNEL_ID, 'hi')).rejects.toThrow(/discord_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no token is sealed', async () => {
    grant(['discord:post']);
    loadMock.mockResolvedValue(undefined);
    await expect(postMessage(OWNER, CHANNEL_ID, 'hi')).rejects.toThrow(/discord_no_token/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts to the correct Discord v10 endpoint and returns the message', async () => {
    grant(['discord:post']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_MESSAGE,
    });

    const result = await postMessage(OWNER, CHANNEL_ID, 'Hello from Jin');

    expect(result).toMatchObject({ id: 'msg_001', channel_id: CHANNEL_ID });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ content: 'Hello from Jin' });
    expect(init.headers['Authorization']).toBe(`Bot ${BOT_TOKEN}`);
  });

  it('publishes a discord.message.posted bus event after a successful post', async () => {
    grant(['discord:post']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_MESSAGE,
    });

    await postMessage(OWNER, CHANNEL_ID, 'Hello');

    expect(publishMock).toHaveBeenCalledOnce();
    const [eventType, payload] = publishMock.mock.calls[0];
    expect(eventType).toBe('discord.message.posted');
    expect(payload.issuer).toBe(OWNER);
    expect(payload.payload.messageId).toBe(MOCK_MESSAGE.id);
  });

  it('does not throw when the bus publish fails (non-fatal)', async () => {
    grant(['discord:post']);
    publishMock.mockRejectedValue(new Error('bus down'));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_MESSAGE,
    });

    // Should resolve even though bus publish throws
    await expect(postMessage(OWNER, CHANNEL_ID, 'Hello')).resolves.toMatchObject({ id: 'msg_001' });
  });

  it('throws a descriptive error on a non-2xx Discord API response', async () => {
    grant(['discord:post']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Missing Access',
    });

    await expect(postMessage(OWNER, CHANNEL_ID, 'hi')).rejects.toThrow(/Discord API error 403/);
  });
});

// ── readMessages ──────────────────────────────────────────────────────────────

describe('readMessages (#18)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(readMessages(OWNER, CHANNEL_ID)).rejects.toThrow(/discord_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no token is sealed', async () => {
    grant(['discord:read']);
    loadMock.mockResolvedValue(undefined);
    await expect(readMessages(OWNER, CHANNEL_ID)).rejects.toThrow(/discord_no_token/);
  });

  it('fetches from the correct endpoint with the default limit', async () => {
    grant(['discord:read']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [MOCK_MESSAGE],
    });

    const messages = await readMessages(OWNER, CHANNEL_ID);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'msg_001', content: 'Hello from Jin' });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain(`/channels/${CHANNEL_ID}/messages?limit=50`);
  });

  it('clamps the limit to 100', async () => {
    grant(['discord:read']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await readMessages(OWNER, CHANNEL_ID, 999);

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('limit=100');
  });

  it('clamps the limit to 1 at minimum', async () => {
    grant(['discord:read']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await readMessages(OWNER, CHANNEL_ID, 0);

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('limit=1');
  });
});

// ── Security invariants ───────────────────────────────────────────────────────

describe('security invariants (#18)', () => {
  it('DISCORD_CONNECTOR_DID is stable', () => {
    expect(DISCORD_CONNECTOR_DID).toBe('did:imajin:discord-connector');
  });

  it('different DIDs have different vault fields (cross-DID isolation)', () => {
    const didA = 'did:imajin:alice';
    const didB = 'did:imajin:bob';
    const fieldA = vaultField(didA);
    const fieldB = vaultField(didB);
    expect(fieldA).not.toBe(fieldB);
    expect(fieldA).toBe(`discord-bot-token:${didA}`);
    expect(fieldB).toBe(`discord-bot-token:${didB}`);
  });
});
