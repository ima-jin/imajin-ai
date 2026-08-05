import { describe, it, expect } from 'vitest';
import { CONNECTOR_REGISTRY, getConnector, type ConnectorEntry } from '../connector-registry';
import {
  connectorCardKind,
  credentialBodyKey,
  credentialSealed,
  disconnectMethod,
  type CredentialSealedFlags,
} from '../connector-card-kind';

// ─── #1604 dispatch guard ─────────────────────────────────────────────────────
//
// `ConnectorDetail` used to dispatch by connector id, so shipping a connector
// meant remembering two separate steps: the registry entry + backend routes, AND
// a hand-added `if (entry.id === 'x')` line. #1432 did the first for Gemini and
// not the second, so /auth/connectors/gemini served "Coming soon" against live
// routes for ten days; #1428/#1602 repeated it for Warp.
//
// These tests are the projection guard that would have caught both: a registry
// entry declaring its backend is live must resolve to a real card.

const LIVE_ENTRIES = CONNECTOR_REGISTRY.filter((e) => !e.backendPending);

/** Entries whose card is the shared credential-paste card. */
const PASTE_ENTRIES = CONNECTOR_REGISTRY.filter(
  (e) => connectorCardKind(e) === 'credential-paste',
);

/**
 * OAuth ids the dispatcher still routes per-id, pending the `OAuthConnectorCard`
 * consolidation that #1604 deliberately deferred. Keep this in lockstep with
 * `OAUTH_CARDS` in ConnectorDetail.tsx: a new OAuth connector must either land in
 * that map or arrive with the consolidation, and this test is what says so.
 */
const OAUTH_CARD_IDS = ['github', 'quickbooks'];

describe('every live connector resolves to a non-pending card', () => {
  it('has at least one live entry to check', () => {
    expect(LIVE_ENTRIES.length).toBeGreaterThan(0);
  });

  it.each(LIVE_ENTRIES.map((e) => e.id))('resolves %s to a real card', (id) => {
    const entry = getConnector(id) as ConnectorEntry;
    expect(connectorCardKind(entry)).not.toBe('pending');
  });

  it('routes every OAuth entry to a card the dispatcher implements', () => {
    const oauthIds = LIVE_ENTRIES.filter((e) => connectorCardKind(e) === 'oauth').map((e) => e.id);
    expect([...oauthIds].sort()).toEqual([...OAUTH_CARD_IDS].sort());
  });

  it('renders backend-pending entries as pending regardless of pattern', () => {
    // Synthetic rather than a loop over the registry: every entry currently
    // declares a live backend, so a loop would assert nothing and quietly pass.
    const pending: ConnectorEntry = { ...(getConnector('gemini') as ConnectorEntry), backendPending: true };
    expect(connectorCardKind(pending)).toBe('pending');
  });
});

describe('card kind is derived from the ingestion pattern', () => {
  it.each([
    ['mcp', 'native'],
    ['github', 'oauth'],
    ['quickbooks', 'oauth'],
    ['discord', 'credential-paste'],
    // #1604 regression: Gemini shipped in #1432 and rendered "Coming soon".
    ['gemini', 'credential-paste'],
    // Same defect, shipped again by #1428/#1602.
    ['warp', 'credential-paste'],
  ])('routes %s to the %s card', (id, kind) => {
    expect(connectorCardKind(getConnector(id) as ConnectorEntry)).toBe(kind);
  });
});

describe('credential-paste entries carry everything their card needs', () => {
  it('covers both paste patterns', () => {
    const patterns = new Set(PASTE_ENTRIES.map((e) => e.ingestionPattern));
    expect(patterns).toEqual(new Set(['token-paste', 'static-secret']));
  });

  it.each(PASTE_ENTRIES.map((e) => e.id))('declares a seal route and copy for %s', (id) => {
    const entry = getConnector(id) as ConnectorEntry;
    expect(entry.statusEndpoint).toBeTruthy();
    expect(entry.tokenRoute).toBeTruthy();
    // Without copy the card falls back to a generic "Credential" label — legal,
    // but never what a shipped connector wants.
    expect(entry.credentialUi).not.toBeNull();
    expect(entry.credentialUi?.label).toBeTruthy();
    expect(entry.credentialUi?.placeholder).toBeTruthy();
    expect(entry.credentialUi?.hint).toBeTruthy();
  });

  it('posts the credential under the body key each route parses', () => {
    // /discord/api/token and /gemini/api/token read `token`; the static-secret
    // factory (#1439) behind /warp/api/seal reads `secret`.
    expect(credentialBodyKey(getConnector('discord') as ConnectorEntry)).toBe('token');
    expect(credentialBodyKey(getConnector('gemini') as ConnectorEntry)).toBe('token');
    expect(credentialBodyKey(getConnector('warp') as ConnectorEntry)).toBe('secret');
  });

  it('disconnects with the verb each route implements', () => {
    expect(disconnectMethod(getConnector('discord') as ConnectorEntry)).toBe('POST');
    // Warp's seal route serves POST (seal) and DELETE (revoke the grant) from
    // one path, so its disconnectRoute is the seal route and the verb is DELETE.
    const warp = getConnector('warp') as ConnectorEntry;
    expect(disconnectMethod(warp)).toBe('DELETE');
    expect(warp.disconnectRoute).toBe(warp.tokenRoute);
  });
});

// ─── #1632 settings guard ──────────────────────────────────────────────────
//
// Non-secret settings are a registry declaration for the same reason card routing
// is: the card renders whatever an entry declares, so an incomplete declaration is
// a half-rendered section rather than a compile error.

const SETTINGS_ENTRIES = CONNECTOR_REGISTRY.filter((e) => e.settings !== null);

describe('connector settings declarations are complete', () => {
  it('is declared explicitly on every entry, so adding one is a visible choice', () => {
    for (const entry of CONNECTOR_REGISTRY) {
      expect(entry).toHaveProperty('settings');
    }
  });

  it.each(SETTINGS_ENTRIES.map((e) => e.id))('gives %s a route and at least one field', (id) => {
    const settings = (getConnector(id) as ConnectorEntry).settings!;
    expect(settings.route).toBeTruthy();
    expect(settings.fields.length).toBeGreaterThan(0);
  });

  it.each(SETTINGS_ENTRIES.map((e) => e.id))('gives every %s field complete copy', (id) => {
    const settings = (getConnector(id) as ConnectorEntry).settings!;
    for (const field of settings.fields) {
      // The key is both the JSON body key and the property read back from GET, so
      // a blank one silently reads and writes nothing.
      expect(field.key).toBeTruthy();
      expect(field.label).toBeTruthy();
      expect(field.placeholder).toBeTruthy();
      expect(field.hint).toBeTruthy();
    }
  });

  it.each(SETTINGS_ENTRIES.map((e) => e.id))('keeps %s field keys unique', (id) => {
    const settings = (getConnector(id) as ConnectorEntry).settings!;
    const keys = settings.fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('routes settings somewhere other than the credential route', () => {
    // Overloading the seal route would make its DELETE ambiguous between revoking
    // a credential and clearing a preference.
    for (const entry of SETTINGS_ENTRIES) {
      expect(entry.settings!.route).not.toBe(entry.tokenRoute);
      expect(entry.settings!.route).not.toBe(entry.disconnectRoute);
    }
  });

  it('lets Warp set its default environment from the card', () => {
    const warp = getConnector('warp') as ConnectorEntry;
    expect(warp.settings?.route).toBe('/warp/api/environment');
    expect(warp.settings?.fields.map((f) => f.key)).toEqual(['environmentId']);
  });
});

describe('credentialSealed normalises the per-connector flag names', () => {
  const cases: ReadonlyArray<{ status: CredentialSealedFlags; expected: boolean }> = [
    { status: { tokenSealed: true }, expected: true },
    { status: { keySealed: true }, expected: true },
    { status: { secretSealed: true }, expected: true },
    { status: { tokenSealed: false }, expected: false },
    { status: { keySealed: false, secretSealed: false }, expected: false },
    { status: {}, expected: false },
  ];

  it.each(cases)('reads $status as $expected', ({ status, expected }) => {
    expect(credentialSealed(status)).toBe(expected);
  });
});
