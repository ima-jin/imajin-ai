import { describe, expect, it } from 'vitest';
import { serviceBadgeClass } from '../service-color';

describe('serviceBadgeClass', () => {
  it('assigns stable palette classes to arbitrary registry slugs', () => {
    const color = serviceBadgeClass('fixture-studio');
    expect(color).toContain('bg-');
    expect(serviceBadgeClass('fixture-studio')).toBe(color);
    expect(serviceBadgeClass('fixture-studio-2')).not.toBe(color);
  });

  it.each(['', 'a'.repeat(1000), 'constructor', '🎨'])('handles any log service name %s', (service) => {
    expect(serviceBadgeClass(service)).toMatch(/^bg-/);
  });
});
