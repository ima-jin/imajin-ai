import { describe, it, expect, vi } from 'vitest';

vi.mock('@/src/db', () => ({
  db: {},
  channelLinks: {
    channel: 'channel',
    appDid: 'appDid',
    did: 'did',
    status: 'status',
    scopes: 'scopes',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
}));
import { buildConnectorConnectionStatus, type ConnectorStatusRow } from '../connector-status';
import type { ConnectorEntry } from '../connector-registry';

const REGISTRY: readonly ConnectorEntry[] = [
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    description: '',
    icon: '',
    ingestionPattern: 'oauth',
    channel: 'quickbooks',
    connectorDid: 'did:imajin:quickbooks-connector',
    scopes: [
      { name: 'quickbooks:read', label: 'Read', releaseClass: 'silent' },
      { name: 'quickbooks:write', label: 'Write', releaseClass: 'on-consent' },
    ],
    statusEndpoint: '/quickbooks/api/scope-manifest',
    backendPending: false,
    connectRoute: '/quickbooks/api/connect',
    configureRoute: '/quickbooks/api/configure',
    tokenRoute: null,
    disconnectRoute: '/quickbooks/api/disconnect',
    credentialUi: null,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    description: '',
    icon: '',
    ingestionPattern: 'token-paste',
    channel: 'gemini',
    connectorDid: 'did:imajin:gemini-connector',
    scopes: [{ name: 'gemini:infer', label: 'Infer', releaseClass: 'owner-only' }],
    statusEndpoint: '/gemini/api/scope-manifest',
    backendPending: false,
    connectRoute: null,
    configureRoute: null,
    tokenRoute: '/gemini/api/token',
    disconnectRoute: null,
    credentialUi: null,
  },
] as const;

describe('buildConnectorConnectionStatus (#1540)', () => {
  it('returns registry-ordered connector statuses with active known scopes only', () => {
    const rows: ConnectorStatusRow[] = [
      {
        channel: 'quickbooks',
        appDid: 'did:imajin:quickbooks-connector',
        scopes: ['quickbooks:write', 'quickbooks:unknown'],
      },
      {
        channel: 'gemini',
        appDid: 'did:imajin:gemini-connector',
        scopes: ['gemini:infer'],
      },
      {
        channel: 'gemini',
        appDid: 'did:imajin:someone-else',
        scopes: ['gemini:infer'],
      },
    ];

    expect(buildConnectorConnectionStatus(rows, REGISTRY)).toEqual([
      { id: 'quickbooks', connected: true, scopes: ['quickbooks:write'] },
      { id: 'gemini', connected: true, scopes: ['gemini:infer'] },
    ]);
  });

  it('marks a connector disconnected when it has no active known scopes', () => {
    const rows: ConnectorStatusRow[] = [
      {
        channel: 'quickbooks',
        appDid: 'did:imajin:quickbooks-connector',
        scopes: ['github:read'],
      },
    ];

    expect(buildConnectorConnectionStatus(rows, REGISTRY)).toEqual([
      { id: 'quickbooks', connected: false, scopes: [] },
      { id: 'gemini', connected: false, scopes: [] },
    ]);
  });
});
