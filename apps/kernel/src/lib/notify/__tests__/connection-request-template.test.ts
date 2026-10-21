import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTemplate } from '../templates';

const template = getTemplate('connection:request-received')!;
const requester = {
  fromName: 'Example Studio', fromHandle: 'studio', fromDid: 'did:imajin:studio',
  actorDid: 'did:imajin:person', actorName: 'Alice Example', note: 'Let’s connect.',
};

afterEach(() => vi.unstubAllEnvs());

describe('connection:request-received', () => {
  it('identifies the requesting org, handle, DID and person acting for it', () => {
    expect(template.urgency).toBe('normal');
    expect(template.title(requester)).toBe('Example Studio wants to connect');
    expect(template.email!.subject(requester)).toBe('Connection request from Example Studio');
    for (const copy of [template.body(requester), template.email!.html(requester)]) {
      expect(copy).toContain('Example Studio (@studio) · did:imajin:studio');
      expect(copy).toContain('Sent by Alice Example on behalf of Example Studio');
      expect(copy).toContain('no membership, roster access, or account access');
      expect(copy).toContain('Let’s connect.');
    }
  });

  it('does not imply delegation for a personal request, and has identity fallbacks', () => {
    const personal = { fromDid: 'did:imajin:person', actorDid: 'did:imajin:person' };
    expect(template.body(personal)).not.toContain('Sent by');
    expect(template.title(personal)).toContain('did:imajin:person');
    expect(template.email!.subject({})).toBe('Connection request from Someone');
    expect(template.body({})).toContain('Someone wants to connect');
    expect(template.body({ fromHandle: '@alice' })).not.toContain('@@alice');
    expect(template.body({ ...requester, actorName: undefined })).toContain('Sent by did:imajin:person');
  });

  it('uses an absolute incoming requests link, never an untrusted supplied URL', () => {
    vi.stubEnv('NEXT_PUBLIC_KERNEL_URL', 'https://node.example.com/');
    const html = template.email!.html({ ...requester, url: 'javascript:alert(1)' });
    expect(html).toContain('href="https://node.example.com/connections#incoming-requests"');
    expect(html).toContain('Accept or decline');
    expect(html).not.toContain('javascript:');
  });
  it('ignores non-string identity/note fields rather than rendering object coercions', () => {
    const copy = template.body({
      fromDid: {}, fromName: {}, fromHandle: {}, actorDid: {}, actorName: {}, note: {},
    });
    expect(copy).toContain('Someone wants to connect');
    expect(copy).not.toContain('[object Object]');
    expect(copy).not.toContain('Note:');
  });

  it('escapes all requester, actor and note text and the URL attribute', () => {
    vi.stubEnv('NEXT_PUBLIC_KERNEL_URL', 'https://node.example.com/?x="&y=<tag>');
    const html = template.email!.html({
      fromName: '<img src=x>', fromHandle: '"><script>', fromDid: "did:imajin:<org>'",
      actorDid: 'did:imajin:actor', actorName: '<b>Alice & Bob</b>', note: '<script>alert("x")</script>',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).not.toContain('<b>Alice');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('&lt;b&gt;Alice &amp; Bob&lt;/b&gt;');
    expect(html).toContain('did:imajin:&lt;org&gt;&#39;');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('?x=&quot;&amp;y=&lt;tag&gt;');
  });
});
