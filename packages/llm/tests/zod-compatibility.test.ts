import { describe, expect, it } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV2 } from 'ai/test';
import { z } from 'zod';
import { createPresenceTools } from '../src/tools';

describe('patched Zod collection limits (#3098)', () => {
  it.each([false, true])('rejects an oversized array before parsing its elements (async=%s)', async asynchronous => {
    let visits = 0;
    const schema = z.array(z.string().superRefine(() => { visits++; })).max(2);
    const input = Array.from({ length: 1000 }, () => 'item');
    const result = asynchronous ? await schema.safeParseAsync(input) : schema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
    expect(visits).toBe(0);
    expect(schema.safeParse(['item']).success).toBe(true);
  });
});

describe('presence tools with AI SDK 5 and Zod 4', () => {
  const tools = createPresenceTools({
    eventsUrl: 'https://example.test/events', connectionsUrl: 'https://example.test/connections',
    authUrl: 'https://example.test/auth', payUrl: 'https://example.test/pay',
    profileUrl: 'https://example.test/profile', learnUrl: 'https://example.test/learn',
    mediaUrl: 'https://example.test/media', mediaApiKey: 'fixture-only-not-a-credential',
    targetDid: 'did:imajin:owner', requesterDid: 'did:imajin:owner', trustDistance: 0,
  });

  it('converts every exposed tool schema through the real SDK and preserves token counts', async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }], finishReason: 'stop',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 }, warnings: [],
      }),
    });
    const result = await generateText({ model, prompt: 'hello', tools });
    expect(result.text).toBe('ok');
    expect(result.usage).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    const converted = model.doGenerateCalls[0].tools ?? [];
    expect(converted).toHaveLength(Object.keys(tools).length);
    for (const tool of converted) {
      expect(tool.type).toBe('function');
      if (tool.type === 'function') expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('preserves tool input validation rather than accepting invalid field types', () => {
    const schema = tools.getProfile.inputSchema as z.ZodType;
    expect(schema.safeParse({ didOrHandle: 'did:imajin:owner' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ didOrHandle: 123 }).success).toBe(false);
  });
});
