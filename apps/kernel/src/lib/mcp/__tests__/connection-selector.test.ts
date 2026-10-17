import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../kernel/connector-registry-store', () => ({ listConnectorRegistrations: list }));

import { resolveToolConnection, withToolConnection } from '../connection-selector';
import { currentConnectionSlot } from '../../kernel/connector-connection-context';
import type { McpTool } from '../types';

const DID = 'did:imajin:owner';
const ctx = { did: DID, appDid: 'did:imajin:app', scopes: new Set<string>() };

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue([
    { provider: 'google', slot: 'primary', label: 'Personal' },
    { provider: 'google', slot: 'work', label: 'Company' },
    { provider: 'github', slot: 'other', label: 'Company' },
  ]);
});

describe('MCP connection selection', () => {
  it('omitted means primary without needing a registry row', async () => {
    expect(await resolveToolConnection(DID, 'google')).toBe('primary');
    expect(list).not.toHaveBeenCalled();
  });

  it('resolves a slot then a unique provider-local label, scoped to caller DID', async () => {
    expect(await resolveToolConnection(DID, 'google', 'work')).toBe('work');
    expect(await resolveToolConnection(DID, 'google', 'Company')).toBe('work');
    expect(list).toHaveBeenCalledWith(DID);
  });

  it('exact slot takes precedence over matching labels', async () => {
    list.mockResolvedValue([
      { provider: 'google', slot: 'work', label: 'First' },
      { provider: 'google', slot: 'other', label: 'work' },
    ]);
    expect(await resolveToolConnection(DID, 'google', 'work')).toBe('work');
  });

  it('ambiguous labels fail with candidate slots instead of choosing an account', async () => {
    list.mockResolvedValue([
      { provider: 'google', slot: 'work', label: 'Company' },
      { provider: 'google', slot: 'business', label: 'Company' },
    ]);
    await expect(resolveToolConnection(DID, 'google', 'Company')).rejects.toThrow(
      "ambiguous_connection: 'Company' matches slots: business, work",
    );
  });

  it.each([null, 42, {}, ''])('rejects invalid selectors (%s)', async (selector) => {
    await expect(resolveToolConnection(DID, 'google', selector)).rejects.toThrow('invalid_connection');
  });

  it('unknown selectors cannot silently borrow primary, or another provider', async () => {
    await expect(resolveToolConnection(DID, 'google', 'other')).rejects.toThrow('unknown_connection');
  });
});

describe('MCP connection execution', () => {
  function tool(name: string): McpTool {
    return {
      name, description: 'test', requiredScope: 'test:read',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false },
      async handler(args, callCtx) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        const provider = name.startsWith('github') ? 'github' : name.startsWith('quickbooks') ? 'quickbooks' : 'google';
        return [{
          type: 'text',
          text: JSON.stringify({
            slot: currentConnectionSlot(provider, callCtx.did),
            otherOwner: currentConnectionSlot(provider, 'did:imajin:other'),
            otherProvider: currentConnectionSlot('unrelated', callCtx.did),
            args,
          }),
        }];
      },
    };
  }

  it.each(['google_gmail_list_threads', 'github_list_repos', 'quickbooks_query'])(
    'advertises optional connection and preserves its scope/schema for %s', (name) => {
      const wrapped = withToolConnection(tool(name));
      expect(wrapped.requiredScope).toBe('test:read');
      expect(wrapped.inputSchema).toMatchObject({
        additionalProperties: false,
        properties: { query: { type: 'string' }, connection: { type: 'string' } },
      });
    },
  );

  it('overlapping same-owner calls keep distinct slots, strip selector, and never leak context', async () => {
    const wrapped = withToolConnection(tool('google_gmail_list_threads'));
    const [primary, work] = await Promise.all([
      wrapped.handler({ query: 'home' }, ctx),
      wrapped.handler({ connection: 'Company', query: 'office' }, ctx),
    ]);
    expect(JSON.parse(primary[0].text)).toEqual({
      slot: 'primary', otherOwner: 'primary', otherProvider: 'primary', args: { query: 'home' },
    });
    expect(JSON.parse(work[0].text)).toEqual({
      slot: 'work', otherOwner: 'primary', otherProvider: 'primary', args: { query: 'office' },
    });
    expect(currentConnectionSlot('google', DID)).toBe('primary');
  });

  it('selection errors never run a provider action', async () => {
    const original = tool('google_gmail_list_threads');
    original.handler = vi.fn();
    await expect(withToolConnection(original).handler({ connection: 'missing' }, ctx)).rejects.toThrow('unknown_connection');
    expect(original.handler).not.toHaveBeenCalled();
  });

  it('unrelated tools keep their original schema and handler', () => {
    const original = tool('media_list');
    expect(withToolConnection(original)).toBe(original);
  });
});
