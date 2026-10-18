// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import JinPage from '../page';

vi.mock('../usage-feed-panel', () => ({ UsageFeedPanel: () => null }));
vi.mock('../operator-approvals-panel', () => ({ OperatorApprovalsPanel: () => null }));
vi.mock('../vault-keys-panel', () => ({ VaultKeysPanel: () => null }));
vi.mock('../access-bearers-panel', () => ({ AccessBearersPanel: () => null }));
vi.mock('../provision-app-panel', () => ({ ProvisionAppPanel: () => null }));
vi.mock('../app-secrets-panel', () => ({ AppSecretsPanel: () => null }));
vi.mock('../grants-panel', () => ({ GrantsPanel: () => null }));
vi.mock('../spend-panel', () => ({ SpendPanel: () => null }));
vi.mock('../runs-panel', () => ({ RunsPanel: () => null }));
vi.mock('../front-door-panel', () => ({ FrontDoorPanel: () => null }));
vi.mock('../push-subscribe-button', () => ({ PushSubscribeButton: () => null }));
vi.mock('../reach-inbox-panel', () => ({ ReachInboxPanel: () => null }));

afterEach(cleanup);
it('links organization mail sender settings from the jin header', () => {
  render(<JinPage />);
  expect(screen.getByRole('link', { name: 'Organization settings' }).getAttribute('href')).toBe('/jin/org-settings');
});
