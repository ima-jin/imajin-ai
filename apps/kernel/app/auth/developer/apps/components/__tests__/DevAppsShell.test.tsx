// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import DevAppsShell from '../DevAppsShell';

vi.mock('../RegisterAppForm', () => ({ default: () => null }));

afterEach(cleanup);

function app(id: string, name: string) {
  return { id, name, description: null, appDid: `did:imajin:${id}`,
    status: 'active', requestedScopes: ['infer:completions'], createdAt: null };
}

describe('developer apps acting identity refresh (#3294)', () => {
  it('replaces personal apps with org apps on refresh and switches back without stale management links', () => {
    const personal = app('personal', 'Personal Jin');
    const organization = app('organization', 'Artifact Jin');
    const { rerender } = render(<DevAppsShell apps={[personal]} />);
    expect(screen.getByText('Personal Jin')).toBeTruthy();
    rerender(<DevAppsShell apps={[organization]} />);
    expect(screen.queryByText('Personal Jin')).toBeNull();
    expect(screen.getByText('Artifact Jin')).toBeTruthy();
    expect(screen.getByText('Manage →').getAttribute('href')).toBe('/auth/developer/apps/organization');
    rerender(<DevAppsShell apps={[personal]} />);
    expect(screen.queryByText('Artifact Jin')).toBeNull();
    expect(screen.getByText('Personal Jin')).toBeTruthy();
  });

  it('clears a previous identity list when the next identity has no apps', () => {
    const { rerender } = render(<DevAppsShell apps={[app('personal', 'Personal Jin')]} />);
    rerender(<DevAppsShell apps={[]} />);
    expect(screen.queryByText('Personal Jin')).toBeNull();
    expect(screen.getByText('No apps registered yet.')).toBeTruthy();
  });
});
