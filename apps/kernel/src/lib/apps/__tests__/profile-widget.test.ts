import { describe, expect, it } from 'vitest';
import { profileWidgetUrl, validateProfileWidget } from '../profile-widget';
import { validateRegistryPresentation } from '../registry-presentation';

const widget = { path: '/profile/studio', label: 'Studio', icon: 'S' };
describe('profileWidget declaration', () => {
  it('is optional, nullable, and accepts a link-only declaration', () => {
    expect(validateProfileWidget(undefined)).toEqual({ ok: null });
    expect(validateProfileWidget(null)).toEqual({ ok: null });
    expect(validateProfileWidget(widget)).toEqual({ ok: widget });
    expect(validateProfileWidget({ path: '/profile', label: 'Profile' })).toHaveProperty('ok');
  });
  it.each([
    [], 'text', 7, {}, { ...widget, label: '' }, { ...widget, label: 'x'.repeat(81) },
    { ...widget, icon: '' }, { ...widget, icon: 'x'.repeat(33) },
    { ...widget, origin: 'https://evil.test' }, { ...widget, html: '<script />' },
    ...['https://evil.test/p', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '/%2fevil', '/%5cevil', '/bad\npath', '/..//evil.test', '/%2e%2e//evil.test'].map((path) => ({ ...widget, path })),
  ])('rejects malformed or independently hosted content: %j', (value) => {
    expect(validateProfileWidget(value)).toHaveProperty('error');
  });
  it('uses only the registered entry origin and URL-encodes owner context', () => {
    const result = profileWidgetUrl('https://studio.example.test/start?launch=1', widget, 'did:imajin:owner', 'a&b');
    const url = new URL(result!);
    expect(url.origin).toBe('https://studio.example.test');
    expect(url.pathname).toBe(widget.path);
    expect(url.searchParams.get('did')).toBe('did:imajin:owner');
    expect(url.searchParams.get('handle')).toBe('a&b');
    expect(profileWidgetUrl('/studio', widget, 'owner')).toBe('/profile/studio?did=owner');
  });
  it.each([null, 'javascript:alert(1)', '//evil.test', 'https://user:pass@evil.test'])('fails closed for unsafe entryUrl %s', (entry) => {
    expect(profileWidgetUrl(entry, widget, 'owner')).toBeNull();
  });
  it('fails closed for absent or unsafe declarations', () => {
    expect(profileWidgetUrl('/studio', null, 'owner')).toBeNull();
    expect(profileWidgetUrl('/studio', { ...widget, path: '//evil.test' }, 'owner')).toBeNull();
  });
});

describe('operator registry presentation', () => {
  it('has inert defaults and permits a widget with no nav placements', () => {
    expect(validateRegistryPresentation({})).toEqual({ ok: { entryUrl: null, profileWidget: null, placements: [], requiredScope: null, icon: null } });
    expect(validateRegistryPresentation({ slug: 'fixture-studio', entryUrl: 'https://studio.example.test', profileWidget: widget })).toHaveProperty('ok.profileWidget', widget);
  });
  it.each([
    { profileWidget: widget }, { slug: 'fixture-studio', profileWidget: widget }, { entryUrl: '//evil.test' }, { entryUrl: 7 },
    { placements: ['unsupported'] }, { placements: 'launcher' }, { icon: 42 }, { icon: 'x'.repeat(33) },
    { requiredScope: 'creator' }, { profileWidget: {} },
  ])('rejects invalid presentation %j', (value) => {
    expect(validateRegistryPresentation(value)).toHaveProperty('error');
  });
});
