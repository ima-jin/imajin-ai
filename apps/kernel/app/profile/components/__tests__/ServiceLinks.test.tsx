// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ServiceLinks } from '../ServiceLinks';
import type { ProfileData } from '../../lib/types';

vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `/${slug}` }));
vi.mock('../AskButton', () => ({ AskButton: () => <div data-testid="ask-button" /> }));

afterEach(() => {
  cleanup();
});

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
  return {
    did: 'did:imajin:abc',
    handle: 'ryan',
    displayName: 'Ryan',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('ServiceLinks (#2425 — registry read via compat mapper)', () => {
  it('shows no service buttons when neither legacy fields nor enabledApps are set', () => {
    render(<ServiceLinks profile={makeProfile()} viewerDid={null} />);
    expect(screen.queryByText('🔗 Links')).toBeNull();
    expect(screen.queryByText('☕ Tip Me')).toBeNull();
  });

  it('shows Links via the legacy featureToggles.links field, linked to /links/<handle>', () => {
    render(<ServiceLinks profile={makeProfile({ featureToggles: { links: 'ryan' } })} viewerDid={null} />);

    const link = screen.getByText('🔗 Links').closest('a');
    expect(link?.getAttribute('href')).toBe('/links/ryan');
    expect(screen.queryByText('☕ Tip Me')).toBeNull();
  });

  it('shows Coffee via the legacy featureToggles.coffee field, linked to /coffee/<handle>', () => {
    render(<ServiceLinks profile={makeProfile({ featureToggles: { coffee: 'ryan' } })} viewerDid={null} />);

    const link = screen.getByText('☕ Tip Me').closest('a');
    expect(link?.getAttribute('href')).toBe('/coffee/ryan');
  });

  it('shows both when enabled via the modern enabledApps array instead', () => {
    render(<ServiceLinks profile={makeProfile({ featureToggles: { enabledApps: ['links', 'coffee'] } })} viewerDid={null} />);

    expect(screen.getByText('🔗 Links')).toBeDefined();
    expect(screen.getByText('☕ Tip Me')).toBeDefined();
  });

  it('does not duplicate a button when both the legacy field and enabledApps enable the same slug', () => {
    render(
      <ServiceLinks
        profile={makeProfile({ featureToggles: { links: 'ryan', enabledApps: ['links'] } })}
        viewerDid={null}
      />,
    );

    expect(screen.getAllByText('🔗 Links')).toHaveLength(1);
  });

  it('treats a null legacy value as disabled', () => {
    render(<ServiceLinks profile={makeProfile({ featureToggles: { links: null } })} viewerDid={null} />);
    expect(screen.queryByText('🔗 Links')).toBeNull();
  });
});
