import { describe, expect, it } from 'vitest';
import { trustGraphInviteEmail } from '../src/templates/invite';

describe('trustGraphInviteEmail', () => {
  it('preserves an ordinary email invitation and optional sections', () => {
    const html = trustGraphInviteEmail({
      inviterName: 'Alice Example', inviterHandle: 'alice',
      inviteUrl: 'https://node.example.com/connections/invite/code',
      note: 'Welcome!', expiresAt: '2026-12-01',
    });
    expect(html).toContain('@alice');
    expect(html).toContain('Welcome!');
    expect(html).toContain('Accept Invitation');
    expect(html).toContain('This invitation expires on 2026-12-01.');
    const minimal = trustGraphInviteEmail({ inviterName: 'Alice Example', inviteUrl: 'https://node.example.com/invite' });
    expect(minimal).toContain('Alice Example');
    expect(minimal).not.toContain('Personal note');
    expect(minimal).not.toContain('This invitation expires');
  });

  it('escapes inviter name and note instead of interpreting user-supplied HTML', () => {
    const html = trustGraphInviteEmail({
      inviterName: '<b>Alice & Bob</b>', note: '<script>alert("hello")</script>',
      inviteUrl: 'https://node.example.com/?code=" onmouseover="bad&next=<tag>',
      expiresAt: '<img src=x>',
    });
    expect(html).toContain('&lt;b&gt;Alice &amp; Bob&lt;/b&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;hello&quot;)&lt;/script&gt;');
    expect(html).toContain('href="https://node.example.com/?code=&quot; onmouseover=&quot;bad&amp;next=&lt;tag&gt;"');
    expect(html).not.toContain('<b>Alice');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
  });

  it('escapes handles in both the introduction and note attribution', () => {
    const html = trustGraphInviteEmail({
      inviterName: 'Alice', inviterHandle: '<img src=x>&"\'', note: 'Hello',
      inviteUrl: 'https://node.example.com/invite',
    });
    expect(html.match(/@&lt;img src=x&gt;&amp;&quot;&#39;/g)).toHaveLength(2);
    expect(html).not.toContain('<img src=x>');
  });
});
