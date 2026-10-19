// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GroupKeyCustodyForm } from '../group-key-custody-form';

afterEach(cleanup);

describe('group-key custody controls', () => {
  it('proposes identifiers only, including revoke, without any secret input', async () => {
    const propose = vi.fn().mockResolvedValue(undefined);
    render(<GroupKeyCustodyForm busy={false} onPropose={propose} />);
    fireEvent.change(screen.getByLabelText('Group DID'), { target: { value: 'did:imajin:group' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Group signing-key custody' }));
    await waitFor(() => expect(propose).toHaveBeenCalledWith('custody-group-key', { groupDid: 'did:imajin:group', purpose: 'domain.issue' }));
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'revoke-group-key' } });
    fireEvent.submit(screen.getByRole('form', { name: 'Group signing-key custody' }));
    await waitFor(() => expect(propose).toHaveBeenCalledWith('revoke-group-key', { groupDid: 'did:imajin:group', purpose: 'domain.issue' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(screen.queryByText(/reveal|copy/i)).toBeNull();
  });

  it('disables submission while a proposal is pending', () => {
    render(<GroupKeyCustodyForm busy onPropose={vi.fn()} />);
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  });
});
