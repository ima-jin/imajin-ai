import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
(globalThis as { React?: typeof React }).React = React;

const mocks = vi.hoisted(() => {
  const whereMock = vi.fn();
  const fromMock = vi.fn(() => ({ where: whereMock }));
  const selectMock = vi.fn(() => ({ from: fromMock }));
  return { whereMock, selectMock };
});

vi.mock('@/src/db', () => ({
  db: {
    select: mocks.selectMock,
  },
  attestations: {},
  attestationSignatures: {},
  identities: {},
}));

vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    React.createElement('a', { href, className }, children),
}));

vi.mock('../../../../app/auth/attestations/components/DocumentSigningCard', () => ({
  default: () => React.createElement('div', null, 'MockDocumentSigningCard'),
}));

function makeWhereOrderByLimitResult(rows: unknown[]) {
  return {
    orderBy: vi.fn(() => ({
      limit: vi.fn().mockResolvedValue(rows),
    })),
  };
}

describe('DocumentList (documents UI)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders needs-signature documents with direct detail links', async () => {
    const { default: DocumentList } = await import('../../../../app/auth/attestations/components/DocumentList');
    mocks.whereMock
      .mockResolvedValueOnce([{ attestationId: 'att_1' }])
      .mockImplementationOnce(() =>
        makeWhereOrderByLimitResult([
          {
            id: 'att_1',
            issuerDid: 'did:imajin:alice',
            subjectDid: 'did:imajin:alice',
            type: 'document.created',
            payload: { title: 'NDA' },
            attestationStatus: 'collecting',
            documentHash: 'bafy-doc-hash',
            documentAssetId: 'asset_1',
            totalSigners: 2,
            issuedAt: new Date('2026-05-22T00:00:00Z'),
            expiresAt: null,
          },
        ])
      )
      .mockResolvedValueOnce([
        {
          id: 'sig_1',
          attestationId: 'att_1',
          signerDid: 'did:imajin:me',
          status: 'pending',
          role: 'signer',
          signedAt: null,
          jws: null,
          createdAt: new Date('2026-05-22T00:00:00Z'),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'did:imajin:me',
          handle: 'me',
          name: 'Me',
          avatarUrl: null,
        },
      ]);

    const element = await DocumentList({ sessionDid: 'did:imajin:me', role: 'needs-signature' });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('Open document detail');
    expect(html).toContain('/auth/documents/att_1');
    expect(html).toContain('MockDocumentSigningCard');
  });

  it('renders an empty-state message when no documents need signature', async () => {
    const { default: DocumentList } = await import('../../../../app/auth/attestations/components/DocumentList');
    mocks.whereMock.mockResolvedValueOnce([]);

    const element = await DocumentList({ sessionDid: 'did:imajin:me', role: 'needs-signature' });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('No documents currently need your signature');
  });
});
