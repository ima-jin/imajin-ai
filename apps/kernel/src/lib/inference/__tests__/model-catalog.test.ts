import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedBrain } from '../brain';

const { egressFetch, warn } = vi.hoisted(() => ({ egressFetch: vi.fn(), warn: vi.fn() }));
vi.mock('@/src/lib/kernel/egress-fetch', () => ({ egressSafeFetch: egressFetch }));
vi.mock('@/src/lib/anthropic/connector', () => ({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com/v1' }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn }) }));

import { listBrainPickerModels, expandUsableModels, resolvePickerModel } from '../model-catalog';

function brain(connector: ResolvedBrain['connector']): ResolvedBrain {
  return {
    connector, provider: connector === 'anthropic' ? 'anthropic' : 'openai',
    modelId: 'picked', credentialDid: 'did:imajin:fixture', apiKey: 'fixture',
    baseURL: 'https://provider.example/v1', pinnedIp: '192.0.2.1',
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('shared picker discovery', () => {
  it.each(['xai', 'openai', 'moonshot', 'zai', 'openrouter'] as const)('uses %s picker normalization and endpoint override', async (connector) => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ data: [{ id: 'picked' }, { id: 'other' }, { id: '' }, {}] }));
    expect(await listBrainPickerModels(brain(connector))).toEqual(['picked', 'other']);
    expect(fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer fixture', Accept: 'application/json' },
    }));
  });

  it('uses Gemini generateContent filtering and resource prefix normalization', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ models: [
      { name: 'models/gemini-other', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-only', supportedGenerationMethods: ['embedContent'] },
    ] }));
    expect(await listBrainPickerModels(brain('gemini'))).toEqual(['picked', 'gemini-other']);
  });

  it('uses the full paginated Anthropic picker with its own header shape', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: 'second' }], has_more: false }));
    expect(await listBrainPickerModels(brain('anthropic'))).toEqual(['picked', 'first', 'second']);
    expect(fetch).toHaveBeenLastCalledWith('https://provider.example/v1/models?after_id=first', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'fixture' }),
    }));
  });

  it('keeps local catalog requests on the pinned egress-safe path, with an optional bearer', async () => {
    egressFetch.mockResolvedValue(Response.json({ data: [{ id: 'local-other' }] }));
    expect(await listBrainPickerModels({ ...brain('local'), apiKey: '' })).toEqual(['picked', 'local-other']);
    expect(egressFetch).toHaveBeenCalledWith('https://provider.example/v1/v1/models', expect.objectContaining({
      headers: { Accept: 'application/json' },
    }), { connector: 'local', timeoutMs: 15_000, pinnedIp: '192.0.2.1' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains only the picked model on upstream rejection', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 403 }));
    expect(await expandUsableModels([brain('moonshot')])).toEqual([{ ...brain('moonshot'), picked: true }]);
    expect(await resolvePickerModel([brain('moonshot')], 'not-listed')).toBeUndefined();
  });

  it('never exposes or logs provider exception contents', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('sensitive-provider-detail'));
    expect(await listBrainPickerModels(brain('moonshot'))).toEqual(['picked']);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sensitive-provider-detail');
  });
});
