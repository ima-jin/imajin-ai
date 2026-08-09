import { describe, it, expect } from 'vitest';
import { iconForSource, composeSource } from '../source-type';

describe('iconForSource', () => {
  it('maps a github source to the github icon', () => {
    expect(iconForSource('github:ima-jin/imajin-ai')).toBe('🐙');
  });

  it('maps a local source to the local icon', () => {
    expect(iconForSource('local:/home/me/notes')).toBe('💻');
  });

  it('falls back to a generic icon for an unrecognized source type', () => {
    expect(iconForSource('mystery:whatever')).toBe('📦');
  });
});

describe('composeSource', () => {
  it('joins the source type and trimmed identifier with a colon', () => {
    expect(composeSource('github', '  ima-jin/imajin-ai  ')).toBe('github:ima-jin/imajin-ai');
  });

  it('preserves paths with colons only at the prefix boundary', () => {
    expect(composeSource('local', '/home/me/notes')).toBe('local:/home/me/notes');
  });
});
