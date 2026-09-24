/**
 * Tests for the SAFE interpolation renderer (#1510) — the security-critical
 * piece of data-driven notify templates. Covers the hard requirements from
 * the issue: escape by default, whitelist only the CTA link/button
 * construct, and (the explicit acceptance test) that an attempt to smuggle
 * HTML/script via an interpolated value is rendered inert.
 */
import { describe, it, expect } from 'vitest';
import { escapeHtml, isSafeTemplateUrl, renderPlainTemplate, renderHtmlTemplate } from '../template-renderer';

describe('escapeHtml', () => {
  it('entity-escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert('x')</script> & "quotes"`)).toBe(
      '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;quotes&quot;',
    );
  });

  it('renders non-scalars as empty string rather than [object Object]', () => {
    expect(escapeHtml({ a: 1 })).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
  });

  it('stringifies numbers', () => {
    expect(escapeHtml(42)).toBe('42');
  });
});

describe('isSafeTemplateUrl', () => {
  it('allows absolute http(s) URLs', () => {
    expect(isSafeTemplateUrl('https://example.com/sign/abc')).toBe(true);
    expect(isSafeTemplateUrl('http://example.com/sign/abc')).toBe(true);
  });

  it('allows root-relative paths', () => {
    expect(isSafeTemplateUrl('/documents/sign/abc')).toBe(true);
  });

  it('rejects javascript: and data: schemes', () => {
    expect(isSafeTemplateUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeTemplateUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects protocol-relative URLs', () => {
    expect(isSafeTemplateUrl('//evil.example.com/x')).toBe(false);
  });

  it('rejects a bare relative path with no leading slash', () => {
    expect(isSafeTemplateUrl('sign/abc')).toBe(false);
  });
});

describe('renderPlainTemplate', () => {
  it('interpolates {{field}} with the raw (non-HTML-escaped) value', () => {
    expect(renderPlainTemplate('{{creatorName}} sent you {{title}}', { creatorName: 'Alice', title: 'a doc' })).toBe(
      'Alice sent you a doc',
    );
  });

  it('renders a missing field as empty string', () => {
    expect(renderPlainTemplate('Hi {{name}}!', {})).toBe('Hi !');
  });

  it('coerces numbers and booleans to strings', () => {
    expect(renderPlainTemplate('{{amount}} / {{ok}}', { amount: 5, ok: true })).toBe('5 / true');
  });

  it('strips CR/LF from an interpolated value (email Subject header-injection defense)', () => {
    const rendered = renderPlainTemplate('Subject: {{name}}', { name: 'Eve\r\nBcc: evil@example.com' });
    expect(rendered).not.toContain('\n');
    expect(rendered).not.toContain('\r');
    expect(rendered).toBe('Subject: Eve Bcc: evil@example.com');
  });
});

describe('renderHtmlTemplate — escape-by-default', () => {
  it('escapes an interpolated value containing a script tag (injection test)', () => {
    const rendered = renderHtmlTemplate('{{creatorName}} sent you {{title}}', {
      creatorName: '<script>alert(document.cookie)</script>',
      title: 'a doc',
    });
    expect(rendered).not.toContain('<script>');
    expect(rendered).toBe('&lt;script&gt;alert(document.cookie)&lt;/script&gt; sent you a doc');
  });

  it('escapes an interpolated value containing an onerror image handler', () => {
    const rendered = renderHtmlTemplate('{{title}}', { title: '<img src=x onerror=alert(1)>' });
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;img');
  });

  it('escapes literal HTML the template ITSELF contains — templates get no raw-HTML passthrough', () => {
    const rendered = renderHtmlTemplate('<strong>{{name}}</strong>', { name: 'Bob' });
    expect(rendered).toBe('&lt;strong&gt;Bob&lt;/strong&gt;');
  });

  it('escapes quotes so a value cannot break out of a surrounding attribute', () => {
    const rendered = renderHtmlTemplate('{{value}}', { value: `"><svg onload=alert(1)>` });
    expect(rendered).not.toContain('<svg');
    expect(rendered).toBe('&quot;&gt;&lt;svg onload=alert(1)&gt;');
  });
});

describe('renderHtmlTemplate — {{cta:field:Label}} whitelist', () => {
  it('renders a safe CTA as a fixed anchor with the escaped label and href', () => {
    const rendered = renderHtmlTemplate('{{creatorName}} sent you {{title}}. {{cta:signUrl:Review & sign the document}}', {
      creatorName: 'Alice',
      title: 'a doc',
      signUrl: 'https://app.example.com/sign/abc123',
    });
    expect(rendered).toBe(
      'Alice sent you a doc. <a href="https://app.example.com/sign/abc123" style="color:#f97316;text-decoration:none;font-weight:600;">Review &amp; sign the document &rarr;</a>',
    );
  });

  it('drops the CTA entirely when the href field resolves to an unsafe URL', () => {
    const rendered = renderHtmlTemplate('Click here: {{cta:signUrl:Sign now}}', {
      signUrl: 'javascript:alert(document.cookie)',
    });
    expect(rendered).not.toContain('<a ');
    expect(rendered).not.toContain('javascript:');
    expect(rendered).toBe('Click here: ');
  });

  it('drops the CTA when the href field is missing entirely', () => {
    const rendered = renderHtmlTemplate('{{cta:signUrl:Sign now}}', {});
    expect(rendered).toBe('');
  });

  it('never re-parses an interpolated DATA value as a CTA construct — only the static template is scanned', () => {
    // An attacker-controlled field value that merely LOOKS like a
    // {{cta:...}} token must render as inert escaped text, never as a live
    // anchor — the CTA whitelist only ever applies to the template string
    // itself, not to substituted values.
    const rendered = renderHtmlTemplate('{{message}}', {
      message: '{{cta:evilUrl:Click me}}',
      evilUrl: 'https://evil.example.com',
    });
    expect(rendered).not.toContain('<a ');
    expect(rendered).not.toContain('evil.example.com');
    expect(rendered).toBe('{{cta:evilUrl:Click me}}');
  });

  it('accepts a root-relative CTA href', () => {
    const rendered = renderHtmlTemplate('{{cta:originUrl:Review pending signatures}}', {
      originUrl: '/jin/pending',
    });
    expect(rendered).toContain('href="/jin/pending"');
  });
});
