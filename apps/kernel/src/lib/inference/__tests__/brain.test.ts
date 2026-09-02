import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockLoadGemini, mockLoadAnthropic, mockLoadXai, mockLoadOpenai, mockLoadMoonshot } = vi.hoisted(() => ({
  mockLoadGemini: vi.fn(),
  mockLoadAnthropic: vi.fn(),
  mockLoadXai: vi.fn(),
  mockLoadOpenai: vi.fn(),
  mockLoadMoonshot: vi.fn(),
}));

vi.mock('@/src/lib/gemini/connector', () => ({
  loadGeminiCredentials: mockLoadGemini,
}));

vi.mock('@/src/lib/anthropic/connector', () => ({
  loadAnthropicCredentials: mockLoadAnthropic,
}));

vi.mock('@/src/lib/xai/connector', () => ({
  loadXaiCredentials: mockLoadXai,
  XAI_BASE_URL: 'https://api.x.ai/v1',
}));

vi.mock('@/src/lib/openai/connector', () => ({
  loadOpenaiCredentials: mockLoadOpenai,
  OPENAI_BASE_URL: 'https://api.openai.com/v1',
}));

vi.mock('@/src/lib/moonshot/connector', () => ({
  loadMoonshotCredentials: mockLoadMoonshot,
  MOONSHOT_BASE_URL: 'https://api.moonshot.ai/v1',
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Mock the DB lookup for app registrant DID
const { mockDbSelect } = vi.hoisted(() => {
  const mockDbSelect = vi.fn();
  return { mockDbSelect };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: (...args: unknown[]) => ({
      from: () => ({
        where: () => ({
          limit: () => mockDbSelect(),
        }),
      }),
    }),
  },
  registryApps: { appDid: 'app_did', ownerDid: 'owner_did' },
}));

// ─── Subject ────────────────────────────────────────────────────────────────

import { resolveBrain, listBrainConnectors, NoBrainSealedError, NoModelSelectedError } from '../brain';

const OWNER = 'did:imajin:farmer';
const APP = 'did:imajin:agrifortress';
const GEMINI_KEY = 'AIzaSy-GEMINI-SEALED';
const ANTHROPIC_KEY = 'sk-ant-SEALED';
const XAI_KEY = 'xai-SEALED';
const OPENAI_KEY = 'sk-SEALED';
const MOONSHOT_KEY = 'sk-moonshot-SEALED';
const APP_KEY = 'AIzaSy-APP-SEALED';

beforeEach(() => {
  // resetAllMocks, not clearAllMocks: resolution short-circuits on the first
  // sealed connector, so a test that seals Gemini leaves its queued Anthropic
  // `mockResolvedValueOnce` unconsumed. clearAllMocks keeps those queues, which
  // then satisfy a later test that expects nothing to be sealed.
  vi.resetAllMocks();
  mockLoadGemini.mockResolvedValue(undefined);
  mockLoadAnthropic.mockResolvedValue(undefined);
  mockLoadXai.mockResolvedValue(undefined);
  mockLoadOpenai.mockResolvedValue(undefined);
  mockLoadMoonshot.mockResolvedValue(undefined);
  // Default: no app registrant found (no parent org DID)
  mockDbSelect.mockResolvedValue([]);
});

// ─── Resolution order ───────────────────────────────────────────────────────

describe('resolveBrain — connection-first resolution (#1621)', () => {
  it('resolves the sealed Gemini connection as an OpenAI-compatible brain', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY, modelId: 'gemini-3.6-flash' });

    const brain = await resolveBrain(OWNER);

    expect(brain).toEqual({
      connector: 'gemini',
      credentialDid: OWNER,
      provider: 'openai',
      modelId: 'gemini-3.6-flash',
      apiKey: GEMINI_KEY,
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    expect(mockLoadGemini).toHaveBeenCalledWith(OWNER);
  });

  it('falls through to Anthropic when no Gemini connection is sealed', async () => {
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY });

    const brain = await resolveBrain(OWNER);

    expect(brain).toEqual({
      connector: 'anthropic',
      credentialDid: OWNER,
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
      apiKey: ANTHROPIC_KEY,
    });
    expect(mockLoadGemini).toHaveBeenCalledWith(OWNER);
    expect(mockLoadAnthropic).toHaveBeenCalledWith(OWNER);
  });

  it('prefers the first sealed connector and does not consult later ones', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY, modelId: 'gemini-3.6-flash' });
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY });

    const brain = await resolveBrain(OWNER);

    expect(brain.connector).toBe('gemini');
    expect(mockLoadAnthropic).not.toHaveBeenCalled();
  });

  it('resolves per-DID for the acting identity, not a shared credential', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY, modelId: 'gemini-3.6-flash' });
    await resolveBrain('did:imajin:alice');

    mockLoadGemini.mockResolvedValueOnce({ apiKey: 'other-key', modelId: 'gemini-3.6-flash' });
    await resolveBrain('did:imajin:bob');

    expect(mockLoadGemini).toHaveBeenNthCalledWith(1, 'did:imajin:alice');
    expect(mockLoadGemini).toHaveBeenNthCalledWith(2, 'did:imajin:bob');
  });
});

// ─── Whose card pays (#1624) ────────────────────────────────────────────────

describe('resolveBrain — owner then app/org DID', () => {
  /**
   * The walk is DID-major and owner-first on purpose: a human's own sealed brain
   * must outrank the app's, so an app can never quietly displace the credential
   * a user chose. Only if the owner has sealed nothing does the app subsidise.
   */
  it('prefers the owner\'s own card over the app\'s', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY, modelId: 'gemini-3.6-flash' });

    const brain = await resolveBrain({ ownerDid: OWNER, appDid: APP });

    expect(brain.credentialDid).toBe(OWNER);
    expect(brain.apiKey).toBe(GEMINI_KEY);
    expect(mockLoadGemini).toHaveBeenCalledTimes(1);
    expect(mockLoadGemini).toHaveBeenCalledWith(OWNER);
  });

  it('falls back to the app/org card when the owner has sealed nothing', async () => {
    mockLoadGemini
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ apiKey: APP_KEY, baseUrl: 'https://app.example/openai', modelId: 'gemini-3.6-flash' });

    const brain = await resolveBrain({ ownerDid: OWNER, appDid: APP });

    expect(brain).toEqual({
      connector: 'gemini',
      credentialDid: APP,
      provider: 'openai',
      modelId: 'gemini-3.6-flash',
      apiKey: APP_KEY,
      baseURL: 'https://app.example/openai',
    });
    expect(mockLoadGemini).toHaveBeenNthCalledWith(1, OWNER);
    expect(mockLoadGemini).toHaveBeenNthCalledWith(2, APP);
  });

  it('exhausts every connector for the owner before trying the app', async () => {
    mockLoadAnthropic
      .mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY })
      .mockResolvedValueOnce({ apiKey: 'app-anthropic-key' });

    const brain = await resolveBrain({ ownerDid: OWNER, appDid: APP });

    // Owner's Anthropic beats the app's Gemini: DID-major, not connector-major.
    expect(brain.credentialDid).toBe(OWNER);
    expect(brain.connector).toBe('anthropic');
  });

  it('checks a DID only once when owner and app are the same', async () => {
    await resolveBrain({ ownerDid: OWNER, appDid: OWNER }).catch(() => undefined);

    expect(mockLoadGemini).toHaveBeenCalledTimes(1);
    expect(mockLoadAnthropic).toHaveBeenCalledTimes(1);
  });

  it('treats a bare string as the owner DID, with no app subsidy', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY, modelId: 'gemini-3.6-flash' });

    const brain = await resolveBrain(OWNER);

    expect(brain.credentialDid).toBe(OWNER);
    expect(mockLoadGemini).toHaveBeenCalledTimes(1);
  });

  it('resolves from the app alone when no owner DID is supplied', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: APP_KEY, modelId: 'gemini-3.6-flash' });

    const brain = await resolveBrain({ appDid: APP });

    expect(brain.credentialDid).toBe(APP);
    expect(mockLoadGemini).toHaveBeenCalledWith(APP);
  });
});

// ─── Gemini has no hardcoded default model (#1769) ────────────────────

describe('resolveBrain — fails closed when a connected connector has no model selected (#1769)', () => {
  /**
   * Gemini deliberately carries no `defaultModelId` (unlike Anthropic): Google
   * retires/renames model ids often enough that a hardcoded fallback goes stale
   * silently — gemini-2.0-flash was shut down while still hardcoded (#1764).
   * The owner must pick a live model from GET /gemini/api/models.
   */
  it('throws NoModelSelectedError when the sealed Gemini key has no modelId', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY });

    await expect(resolveBrain(OWNER)).rejects.toBeInstanceOf(NoModelSelectedError);
  });

  it('names the connector and its token route in the error, without the key', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY });

    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoModelSelectedError);

    expect(err.message).toContain('Gemini');
    expect(err.message).toContain('/gemini/api/token');
    expect(err.message).not.toContain(GEMINI_KEY);
  });

  it('does not fall through to a healthy Anthropic key — the Gemini DID IS connected', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY });
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY });

    await expect(resolveBrain(OWNER)).rejects.toBeInstanceOf(NoModelSelectedError);
    expect(mockLoadAnthropic).not.toHaveBeenCalled();
  });

  it('resolves fine once a modelId is sealed alongside the key', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY, modelId: 'gemini-3.6-flash' });

    const brain = await resolveBrain(OWNER);

    expect(brain.modelId).toBe('gemini-3.6-flash');
  });

  it('never blocks Anthropic, which still carries a defaultModelId', async () => {
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY });

    const brain = await resolveBrain(OWNER);

    expect(brain.modelId).toBe('claude-sonnet-4-20250514');
  });
});

// ─── The owner's sealed model choice ───────────────────────────────

describe('resolveBrain — app registrant org DID walk', () => {
  const ORG = 'did:imajin:agrifortress-org';

  it('walks up to the app registrant org DID when owner and app have no key', async () => {
    // Gemini key sealed on the org DID (3rd hop), not user or app
    mockLoadGemini.mockImplementation(async (did: string) =>
      did === ORG ? { apiKey: 'AIzaSy-ORG-KEY', modelId: 'gemini-3.6-flash' } : undefined,
    );
    mockDbSelect.mockResolvedValueOnce([{ ownerDid: ORG }]);

    const brain = await resolveBrain({ ownerDid: OWNER, appDid: APP });

    expect(brain.credentialDid).toBe(ORG);
    expect(brain.apiKey).toBe('AIzaSy-ORG-KEY');
    expect(brain.connector).toBe('gemini');
  });

  it('owner key still wins over org key', async () => {
    mockLoadGemini.mockImplementation(async (did: string) =>
      did === OWNER
        ? { apiKey: GEMINI_KEY, modelId: 'gemini-3.6-flash' }
        : did === ORG ? { apiKey: 'AIzaSy-ORG-KEY', modelId: 'gemini-3.6-flash' } : undefined,
    );
    mockDbSelect.mockResolvedValueOnce([{ ownerDid: ORG }]);

    const brain = await resolveBrain({ ownerDid: OWNER, appDid: APP });

    expect(brain.credentialDid).toBe(OWNER);
    expect(brain.apiKey).toBe(GEMINI_KEY);
  });

  it('dedupes the registrant DID when it equals the owner', async () => {
    mockLoadGemini.mockResolvedValue(undefined);
    mockDbSelect.mockResolvedValueOnce([{ ownerDid: OWNER }]);

    await resolveBrain({ ownerDid: OWNER, appDid: APP }).catch(() => undefined);

    // Gemini should only be probed twice (owner + app), not three times
    expect(mockLoadGemini).toHaveBeenCalledTimes(2);
  });

  it('skips the registrant hop gracefully when the app is not in the registry', async () => {
    mockDbSelect.mockResolvedValueOnce([]);

    await expect(resolveBrain({ ownerDid: OWNER, appDid: APP })).rejects.toThrow(NoBrainSealedError);
  });
});

describe('resolveBrain — sealing a key is choosing a model', () => {
  it('uses the sealed modelId over the connector default', async () => {
    mockLoadGemini.mockResolvedValueOnce({ apiKey: GEMINI_KEY, modelId: 'gemini-2.5-pro' });

    expect((await resolveBrain(OWNER)).modelId).toBe('gemini-2.5-pro');
  });

  it('uses the sealed baseUrl over the connector default', async () => {
    mockLoadGemini.mockResolvedValueOnce({
      apiKey: GEMINI_KEY,
      baseUrl: 'https://my-gateway.example/openai',
      modelId: 'gemini-3.6-flash',
    });

    expect((await resolveBrain(OWNER)).baseURL).toBe('https://my-gateway.example/openai');
  });

  it('lets an Anthropic owner pick their Claude model', async () => {
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY, modelId: 'claude-opus-4-20250514' });

    const brain = await resolveBrain(OWNER);

    expect(brain.modelId).toBe('claude-opus-4-20250514');
    expect(brain.provider).toBe('anthropic');
  });

  it('omits baseURL for Anthropic when none is sealed, leaving the SDK default', async () => {
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY });

    expect(await resolveBrain(OWNER)).not.toHaveProperty('baseURL');
  });
});

// ─── Fail closed ────────────────────────────────────────────────────────────

describe('resolveBrain — fail closed with no env fallback', () => {
  /**
   * The whole point of #1621: the kernel brings no brain. Env keys are being
   * removed, so a stray GEMINI_API_KEY / ANTHROPIC_API_KEY in the process must
   * NOT satisfy resolution — otherwise a user's inference silently runs on a
   * shared node credential.
   */
  it('throws even when env API keys are present', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'env-gemini-key');
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic-key');
    vi.stubEnv('OPENAI_API_KEY', 'env-openai-key');

    await expect(resolveBrain(OWNER)).rejects.toBeInstanceOf(NoBrainSealedError);

    vi.unstubAllEnvs();
  });

  it('names every available connector and its scope so the error is actionable', async () => {
    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err).toBeInstanceOf(NoBrainSealedError);
    expect(err.message).toContain('inference_no_brain');
    expect(err.message).toContain(OWNER);
    expect(err.message).toContain('gemini:infer');
    expect(err.message).toContain('/gemini/api/token');
    expect(err.message).toContain('anthropic:infer');
    expect(err.message).toContain('/anthropic/api/token');
  });

  it('reports every DID it tried, so a failed app subsidy is visible', async () => {
    const err = await resolveBrain({ ownerDid: OWNER, appDid: APP })
      .catch((e: unknown) => e as NoBrainSealedError);

    expect(err.triedDids).toEqual([OWNER, APP]);
    expect(err.message).toContain(OWNER);
    expect(err.message).toContain(APP);
  });

  it('carries the available connector ids for programmatic callers', async () => {
    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err.availableConnectors).toEqual(['gemini', 'anthropic', 'xai', 'openai', 'moonshot']);
    expect(err.triedDids).toEqual([OWNER]);
  });

  it('fails closed rather than resolving when no DID is supplied at all', async () => {
    const err = await resolveBrain({}).catch((e: unknown) => e as NoBrainSealedError);

    expect(err).toBeInstanceOf(NoBrainSealedError);
    expect(err.triedDids).toEqual([]);
    expect(mockLoadGemini).not.toHaveBeenCalled();
  });

  it('never puts a credential in the error message', async () => {
    const err = await resolveBrain(OWNER).catch((e: unknown) => e as Error);

    expect(err.message).not.toContain(GEMINI_KEY);
    expect(err.message).not.toContain(ANTHROPIC_KEY);
  });

  it('reports connector probe failures on the error rather than swallowing them', async () => {
    mockLoadGemini.mockRejectedValueOnce(new Error('vault integrity failure'));

    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err).toBeInstanceOf(NoBrainSealedError);
    expect(err.failures).toEqual([
      { connector: 'gemini', credentialDid: OWNER, cause: 'Error: vault integrity failure' },
    ]);
  });
});

// ─── One bad card does not take the others down (#1637) ─────────────────────

describe('resolveBrain — a throwing connector is skipped, not fatal', () => {
  /**
   * The #1637 failure in one test: Gemini is first in BRAIN_CONNECTORS, and under
   * Tier 1 its sealed-but-ungranted key made `loadCredentials` throw. That escaped
   * resolution entirely, so a healthy Anthropic key was never reached and ALL
   * inference for the DID went down.
   */
  it('falls through to a healthy connector when an earlier one throws', async () => {
    mockLoadGemini.mockRejectedValueOnce(new Error('gemini_credential_pending'));
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY });

    const brain = await resolveBrain(OWNER);

    expect(brain.connector).toBe('anthropic');
    expect(brain.apiKey).toBe(ANTHROPIC_KEY);
  });

  it('keeps walking to the app/org DID when the owner\'s card throws', async () => {
    mockLoadGemini
      .mockRejectedValueOnce(new Error('vault unavailable'))
      .mockResolvedValueOnce({ apiKey: APP_KEY, modelId: 'gemini-3.6-flash' });

    const brain = await resolveBrain({ ownerDid: OWNER, appDid: APP });

    expect(brain.credentialDid).toBe(APP);
    expect(brain.apiKey).toBe(APP_KEY);
  });

  it('still fails closed when every connector throws', async () => {
    mockLoadGemini.mockRejectedValue(new Error('gemini boom'));
    mockLoadAnthropic.mockRejectedValue(new Error('anthropic boom'));
    mockLoadXai.mockRejectedValue(new Error('xai boom'));
    mockLoadOpenai.mockRejectedValue(new Error('openai boom'));
    mockLoadMoonshot.mockRejectedValue(new Error('moonshot boom'));

    const err = await resolveBrain({ ownerDid: OWNER, appDid: APP })
      .catch((e: unknown) => e as NoBrainSealedError);

    expect(err).toBeInstanceOf(NoBrainSealedError);
    // Every (DID, connector) pair was attempted, and each failure is recorded.
    expect(err.failures.map((f) => `${f.credentialDid}/${f.connector}`)).toEqual([
      `${OWNER}/gemini`,
      `${OWNER}/anthropic`,
      `${OWNER}/xai`,
      `${OWNER}/openai`,
      `${OWNER}/moonshot`,
      `${APP}/gemini`,
      `${APP}/anthropic`,
      `${APP}/xai`,
      `${APP}/openai`,
      `${APP}/moonshot`,
    ]);
  });

  it('says the walk was degraded without embedding the underlying error', async () => {
    mockLoadGemini.mockRejectedValueOnce(new Error(`vault said ${GEMINI_KEY}`));

    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err.message).toContain('1 connector probe(s) failed');
    // A vault/provider message can carry the value being read, so it stays in
    // `failures` and the logs — never in the message a surface may echo.
    expect(err.message).not.toContain(GEMINI_KEY);
  });

  it('records no failures when the DIDs simply have nothing sealed', async () => {
    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err.failures).toEqual([]);
    expect(err.message).not.toContain('probe(s) failed');
  });
});

// ─── The table is the source of truth ───────────────────────────────────────

describe('listBrainConnectors', () => {
  it('reports the brain connectors in resolution order', () => {
    expect(listBrainConnectors()).toEqual(['gemini', 'anthropic', 'xai', 'openai', 'moonshot']);
  });
});

// ─── xAI (#1924) ────────────────────────────────────────────────────────────

describe('resolveBrain — the xAI card (#1924)', () => {
  /**
   * xAI speaks the OpenAI-compatible surface, so the resolved brain must name
   * the `openai` adapter pointed at api.x.ai — not a new provider. Getting this
   * wrong fails at `getModel()` with "Unknown provider", well after resolution.
   */
  it('resolves as an OpenAI-compatible brain pointed at xAI', async () => {
    mockLoadXai.mockResolvedValueOnce({ apiKey: XAI_KEY, modelId: 'grok-4' });

    const brain = await resolveBrain(OWNER);

    expect(brain).toEqual({
      connector: 'xai',
      credentialDid: OWNER,
      provider: 'openai',
      modelId: 'grok-4',
      apiKey: XAI_KEY,
      baseURL: 'https://api.x.ai/v1',
    });
  });

  /**
   * The #1769 decision, applied to a third provider: no `defaultModelId`, so a
   * sealed key with no model chosen fails closed with "pick a model" instead of
   * silently running whichever Grok id was hardcoded when this shipped.
   */
  it('fails closed with NoModelSelectedError when no model is sealed', async () => {
    mockLoadXai.mockResolvedValueOnce({ apiKey: XAI_KEY });

    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoModelSelectedError);

    expect(err).toBeInstanceOf(NoModelSelectedError);
    expect(err.message).toContain('/xai/api/token');
    expect(err.message).not.toContain(XAI_KEY);
  });

  /**
   * Appended, not inserted: the table's order IS resolution priority, so an
   * existing dual-sealed DID must keep the brain it already had.
   */
  it('does not displace an earlier sealed connector', async () => {
    mockLoadAnthropic.mockResolvedValueOnce({ apiKey: ANTHROPIC_KEY });
    mockLoadXai.mockResolvedValueOnce({ apiKey: XAI_KEY, modelId: 'grok-4' });

    expect((await resolveBrain(OWNER)).connector).toBe('anthropic');
    expect(mockLoadXai).not.toHaveBeenCalled();
  });

  it('names xai:infer and its token route in the fail-closed error', async () => {
    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err.message).toContain('xai:infer');
    expect(err.message).toContain('/xai/api/token');
  });
});

// ─── OpenAI (#1927) ─────────────────────────────────────────────────────────

describe('resolveBrain — the OpenAI card (#1927)', () => {
  /**
   * OpenAI's own adapter is `openai` pointed at api.openai.com — the plain,
   * unmodified case the `openai` provider adapter exists for.
   */
  it('resolves as an OpenAI brain', async () => {
    mockLoadOpenai.mockResolvedValueOnce({ apiKey: OPENAI_KEY, modelId: 'gpt-5.5' });

    const brain = await resolveBrain(OWNER);

    expect(brain).toEqual({
      connector: 'openai',
      credentialDid: OWNER,
      provider: 'openai',
      modelId: 'gpt-5.5',
      apiKey: OPENAI_KEY,
      baseURL: 'https://api.openai.com/v1',
    });
  });

  /**
   * The #1769 decision, applied to a fourth provider: no `defaultModelId`, so a
   * sealed key with no model chosen fails closed with "pick a model" instead of
   * silently running whichever OpenAI id was hardcoded when this shipped.
   */
  it('fails closed with NoModelSelectedError when no model is sealed', async () => {
    mockLoadOpenai.mockResolvedValueOnce({ apiKey: OPENAI_KEY });

    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoModelSelectedError);

    expect(err).toBeInstanceOf(NoModelSelectedError);
    expect(err.message).toContain('/openai/api/token');
    expect(err.message).not.toContain(OPENAI_KEY);
  });

  /**
   * Appended, not inserted: the table's order IS resolution priority, so an
   * existing dual-sealed DID must keep the brain it already had.
   */
  it('does not displace an earlier sealed connector', async () => {
    mockLoadXai.mockResolvedValueOnce({ apiKey: XAI_KEY, modelId: 'grok-4' });
    mockLoadOpenai.mockResolvedValueOnce({ apiKey: OPENAI_KEY, modelId: 'gpt-5.5' });

    expect((await resolveBrain(OWNER)).connector).toBe('xai');
    expect(mockLoadOpenai).not.toHaveBeenCalled();
  });

  it('names openai:infer and its token route in the fail-closed error', async () => {
    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err.message).toContain('openai:infer');
    expect(err.message).toContain('/openai/api/token');
  });
});

// ─── Moonshot AI (#1930) ────────────────────────────────────────────────────

describe('resolveBrain — the Moonshot card (#1930)', () => {
  /**
   * Moonshot speaks the OpenAI-compatible surface, so the resolved brain must
   * name the `openai` adapter pointed at api.moonshot.ai — not a new
   * provider, the same move xAI/OpenAI already make.
   */
  it('resolves as an OpenAI-compatible brain pointed at Moonshot', async () => {
    mockLoadMoonshot.mockResolvedValueOnce({ apiKey: MOONSHOT_KEY, modelId: 'kimi-k2-0905-preview' });

    const brain = await resolveBrain(OWNER);

    expect(brain).toEqual({
      connector: 'moonshot',
      credentialDid: OWNER,
      provider: 'openai',
      modelId: 'kimi-k2-0905-preview',
      apiKey: MOONSHOT_KEY,
      baseURL: 'https://api.moonshot.ai/v1',
    });
  });

  /**
   * The #1769 decision, applied to a fifth provider: no `defaultModelId`, so a
   * sealed key with no model chosen fails closed with "pick a model" instead
   * of silently running whichever Kimi id was hardcoded when this shipped.
   */
  it('fails closed with NoModelSelectedError when no model is sealed', async () => {
    mockLoadMoonshot.mockResolvedValueOnce({ apiKey: MOONSHOT_KEY });

    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoModelSelectedError);

    expect(err).toBeInstanceOf(NoModelSelectedError);
    expect(err.message).toContain('/moonshot/api/token');
    expect(err.message).not.toContain(MOONSHOT_KEY);
  });

  /**
   * Appended, not inserted: the table's order IS resolution priority, so an
   * existing dual-sealed DID must keep the brain it already had.
   */
  it('does not displace an earlier sealed connector', async () => {
    mockLoadOpenai.mockResolvedValueOnce({ apiKey: OPENAI_KEY, modelId: 'gpt-5.5' });
    mockLoadMoonshot.mockResolvedValueOnce({ apiKey: MOONSHOT_KEY, modelId: 'kimi-k2-0905-preview' });

    expect((await resolveBrain(OWNER)).connector).toBe('openai');
    expect(mockLoadMoonshot).not.toHaveBeenCalled();
  });

  it('names moonshot:infer and its token route in the fail-closed error', async () => {
    const err = await resolveBrain(OWNER).catch((e: unknown) => e as NoBrainSealedError);

    expect(err.message).toContain('moonshot:infer');
    expect(err.message).toContain('/moonshot/api/token');
  });
});
