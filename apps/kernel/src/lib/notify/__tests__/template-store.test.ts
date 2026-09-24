/**
 * Tests for template-store.ts (#1510): getTemplate() reads a
 * `notify.templates` row through a cache and falls back to the in-code
 * registry (`./templates.ts`) whenever no row exists, the row is disabled,
 * or the DB lookup fails — plus the bus hot-reload that invalidates a
 * scope's cache entry on `notify.template.updated`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectLimitMock, dbSelectMock } = vi.hoisted(() => {
  const selectLimitMock = vi.fn().mockResolvedValue([]);
  const dbSelectMock = vi.fn(() => ({
    from: () => ({ where: () => ({ limit: selectLimitMock }) }),
  }));
  return { selectLimitMock, dbSelectMock };
});

vi.mock('@/src/db', () => ({
  db: { select: dbSelectMock },
  notifyTemplates: { scope: 'scope' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

const { codeTemplateMock } = vi.hoisted(() => ({ codeTemplateMock: vi.fn() }));

vi.mock('../templates', () => ({ getTemplate: codeTemplateMock }));

// getReactor/registerReactor are the real, tiny in-memory registry — no
// need to mock @imajin/bus itself.

import { getReactor } from '@imajin/bus';
import {
  getTemplate,
  invalidateNotifyTemplateCache,
  clearNotifyTemplateCacheForTests,
} from '../template-store';

const SCOPE = 'auth:document-signature-request';

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE,
    urgency: 'urgent',
    subjectTpl: '{{creatorName}} sent you a document to sign',
    bodyTpl: 'You have been asked to review and sign "{{title}}".',
    htmlTpl: '{{creatorName}} asks you to sign {{title}}. {{cta:signUrl:Review & sign}}',
    enabled: true,
    ...overrides,
  };
}

beforeEach(() => {
  clearNotifyTemplateCacheForTests();
  dbSelectMock.mockClear();
  selectLimitMock.mockReset().mockResolvedValue([]);
  codeTemplateMock.mockReset().mockReturnValue({
    scope: SCOPE,
    urgency: 'urgent' as const,
    title: () => 'code-fallback title',
    body: () => 'code-fallback body',
    email: { subject: () => 'code-fallback subject', html: () => '<p>code-fallback</p>' },
  });
});

describe('getTemplate — fallback to the in-code registry', () => {
  it('falls back when no DB row exists for the scope', async () => {
    const template = await getTemplate(SCOPE);
    expect(template?.title({})).toBe('code-fallback title');
    expect(codeTemplateMock).toHaveBeenCalledWith(SCOPE);
  });

  it('falls back when a DB row exists but is disabled — the rollout gate', async () => {
    selectLimitMock.mockResolvedValue([dbRow({ enabled: false })]);
    const template = await getTemplate(SCOPE);
    expect(template?.title({})).toBe('code-fallback title');
  });

  it('falls back when the DB lookup throws (fail-open)', async () => {
    selectLimitMock.mockRejectedValue(new Error('connection refused'));
    const template = await getTemplate(SCOPE);
    expect(template?.title({})).toBe('code-fallback title');
  });
});

describe('getTemplate — DB-backed row', () => {
  it('renders title/body/email from the row templates when enabled', async () => {
    selectLimitMock.mockResolvedValue([dbRow()]);
    const template = await getTemplate(SCOPE);
    const data = { creatorName: 'Alice', title: 'the doc', signUrl: 'https://app.example.com/sign/1' };

    expect(template?.urgency).toBe('urgent');
    expect(template?.title(data)).toBe('Alice sent you a document to sign');
    expect(template?.body(data)).toBe('You have been asked to review and sign "the doc".');
    expect(template?.email?.subject(data)).toBe('Alice sent you a document to sign');
    expect(template?.email?.html(data)).toContain('<a href="https://app.example.com/sign/1"');
    expect(template?.email?.html(data)).not.toContain('<script>');
  });

  it('escapes an injected value inside the DB-backed HTML render path end-to-end', async () => {
    selectLimitMock.mockResolvedValue([dbRow()]);
    const template = await getTemplate(SCOPE);
    const html = template!.email!.html({
      creatorName: '<script>alert(1)</script>',
      title: 'the doc',
      signUrl: 'https://app.example.com/sign/1',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('has no email leg when html_tpl is null', async () => {
    selectLimitMock.mockResolvedValue([dbRow({ htmlTpl: null })]);
    const template = await getTemplate(SCOPE);
    expect(template?.email).toBeUndefined();
  });

  it('caches the row so a second call within the TTL does not re-query the DB', async () => {
    selectLimitMock.mockResolvedValue([dbRow()]);
    await getTemplate(SCOPE);
    await getTemplate(SCOPE);
    expect(dbSelectMock).toHaveBeenCalledTimes(1);
  });
});

describe('cache invalidation', () => {
  it('invalidateNotifyTemplateCache forces the next call to re-query the DB', async () => {
    selectLimitMock.mockResolvedValue([dbRow()]);
    await getTemplate(SCOPE);
    expect(dbSelectMock).toHaveBeenCalledTimes(1);

    invalidateNotifyTemplateCache(SCOPE);
    await getTemplate(SCOPE);
    expect(dbSelectMock).toHaveBeenCalledTimes(2);
  });
});

describe('notify.template.updated bus hot-reload', () => {
  it('registers a notify-template-hot-reload reactor', () => {
    expect(getReactor('notify-template-hot-reload')).toBeTypeOf('function');
  });

  it('invalidates only the affected scope when the reactor fires', async () => {
    selectLimitMock.mockResolvedValue([dbRow()]);
    await getTemplate(SCOPE);
    await getTemplate('some:other-scope');
    expect(dbSelectMock).toHaveBeenCalledTimes(2);

    const reactor = getReactor('notify-template-hot-reload')!;
    await reactor(
      {
        type: 'notify.template.updated',
        issuer: 'did:imajin:node',
        subject: 'did:imajin:node',
        scope: 'notify',
        payload: { scope: SCOPE, context_id: SCOPE, context_type: 'notify.template' },
      },
      {},
    );

    // The updated scope re-queries; the untouched scope stays cached.
    await getTemplate(SCOPE);
    await getTemplate('some:other-scope');
    expect(dbSelectMock).toHaveBeenCalledTimes(3);
  });

  it('is a no-op when the event carries no payload.scope', async () => {
    const reactor = getReactor('notify-template-hot-reload')!;
    await expect(
      reactor(
        {
          type: 'notify.template.updated',
          issuer: 'did:imajin:node',
          subject: 'did:imajin:node',
          scope: 'notify',
          payload: {},
        },
        {},
      ),
    ).resolves.toBeUndefined();
  });
});
