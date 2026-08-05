import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWhere, mockFrom, mockSelect } = vi.hoisted(() => {
  const mockWhere = vi.fn();
  const mockFrom = vi.fn(() => ({ where: mockWhere }));
  const mockSelect = vi.fn(() => ({ from: mockFrom }));
  return { mockWhere, mockFrom, mockSelect };
});

vi.mock('@/src/db', () => ({
  db: { select: mockSelect },
  channelLinks: {
    channel: 'channel',
    appDid: 'appDid',
    did: 'did',
    status: 'status',
    scopes: 'scopes',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
}));
import {
  buildConnectorConnectionStatus,
  readConnectorConnectionStatus,
  type ConnectorStatusRow,
} from '../connector-status';
import { CONNECTOR_REGISTRY, type ConnectorEntry } from '../connector-registry';

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

  /**
   * `channel_links.scopes` is a jsonb column, so a malformed or legacy row can
   * hold something other than an array of strings. Treating that as "connected"
   * would have the app assert a profile fact the grant does not support.
   */
  it.each([
    ['null', null],
    ['an object', { 'quickbooks:write': true }],
    ['a bare string', 'quickbooks:write'],
    ['mixed junk entries', [42, null, 'quickbooks:write']],
  ])('ignores non-string scope payloads when scopes is %s', (_label, scopes) => {
    const rows: ConnectorStatusRow[] = [
      { channel: 'quickbooks', appDid: 'did:imajin:quickbooks-connector', scopes },
    ];

    const [quickbooks] = buildConnectorConnectionStatus(rows, REGISTRY);
    const expected = Array.isArray(scopes) ? ['quickbooks:write'] : [];

    expect(quickbooks).toEqual({
      id: 'quickbooks',
      connected: expected.length > 0,
      scopes: expected,
    });
  });

  it('defaults to the real connector registry', () => {
    expect(buildConnectorConnectionStatus([]).map((status) => status.id)).toEqual(
      CONNECTOR_REGISTRY.map((connector) => connector.id),
    );
  });
});

describe('readConnectorConnectionStatus (#1540)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFrom.mockImplementation(() => ({ where: mockWhere }));
    mockSelect.mockImplementation(() => ({ from: mockFrom }));
    mockWhere.mockResolvedValue([]);
  });

  it('reads only the acting DID\'s active links and never selects credential columns', async () => {
    await readConnectorConnectionStatus('did:imajin:supplier');

    expect(mockSelect).toHaveBeenCalledWith({
      channel: 'channel',
      appDid: 'appDid',
      scopes: 'scopes',
    });
    expect(mockWhere).toHaveBeenCalledWith({
      and: [
        { eq: ['did', 'did:imajin:supplier'] },
        { eq: ['status', 'active'] },
      ],
    });
  });

  it('projects the returned rows through the real connector registry', async () => {
    mockWhere.mockResolvedValueOnce([
      { channel: 'gemini', appDid: 'did:imajin:gemini-connector', scopes: ['gemini:infer'] },
    ]);

    const statuses = await readConnectorConnectionStatus('did:imajin:supplier');

    expect(statuses).toEqual(
      CONNECTOR_REGISTRY.map((connector) => ({
        id: connector.id,
        connected: connector.id === 'gemini',
        scopes: connector.id === 'gemini' ? ['gemini:infer'] : [],
      })),
    );
  });

  it('propagates database errors so the route can fail closed', async () => {
    mockWhere.mockRejectedValueOnce(new Error('connection reset'));

    await expect(readConnectorConnectionStatus('did:imajin:supplier')).rejects.toThrow('connection reset');
  });
});
