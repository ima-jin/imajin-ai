// @vitest-environment jsdom
/**
 * DeleteConversationButton (#1651).
 *
 * The delete cascades to every message, reaction and read marker in the
 * conversation for every participant, so the two things worth pinning are that
 * a single click cannot trigger it and that a refused delete does not fake a
 * success to the caller.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DeleteConversationButton } from '../DeleteConversationButton';

const DID = 'did:imajin:group:abc123';
const ENCODED = encodeURIComponent(DID);
const NAME = 'Team Standup';
const TRIGGER = `Delete conversation ${NAME}`;
const GENERIC_FAILURE = 'Failed to delete conversation';

function installFetch(status = 200) {
  const spy = vi.fn(async () => ({ ok: status < 400, status, json: async () => ({}) }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderButton(overrides: Partial<Parameters<typeof DeleteConversationButton>[0]> = {}) {
  const onDeleted = vi.fn();
  const onError = vi.fn();
  render(
    <DeleteConversationButton did={DID} name={NAME} onDeleted={onDeleted} onError={onError} {...overrides} />,
  );
  return { onDeleted, onError };
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: TRIGGER }));
}

/** The confirm-step "Delete", not the trigger — both are labelled "Delete". */
function confirmButton(): HTMLElement {
  const dialog = screen.getByRole('dialog');
  const button = Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === 'Delete');
  if (!button) throw new Error('no confirm button in the dialog');
  return button;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('confirmation gate', () => {
  it('does not call the API on the first click', () => {
    const spy = installFetch();
    renderButton();

    openDialog();

    expect(screen.getByRole('dialog')).toBeDefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('names the conversation in the confirmation copy', () => {
    installFetch();
    renderButton();

    openDialog();

    expect(screen.getByText(new RegExp(NAME))).toBeDefined();
  });

  it('cancelling closes the dialog without deleting', () => {
    const spy = installFetch();
    const { onDeleted } = renderButton();

    openDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });
});

describe('confirmed delete', () => {
  it('DELETEs the URL-encoded conversation DID and reports the deletion', async () => {
    const spy = installFetch();
    const { onDeleted, onError } = renderButton();

    openDialog();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(DID));
    expect(spy).toHaveBeenCalledWith(
      `/chat/api/conversations/${ENCODED}`,
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('refused delete', () => {
  it('surfaces the creator-only rule on a 403 and keeps the row', async () => {
    installFetch(403);
    const { onDeleted, onError } = renderButton();

    openDialog();
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Only the creator can delete this conversation'),
    );
    expect(await screen.findByRole('alert')).toBeDefined();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('reports a generic failure on a 500', async () => {
    installFetch(500);
    const { onDeleted, onError } = renderButton();

    openDialog();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onError).toHaveBeenCalledWith(GENERIC_FAILURE));
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('reports a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { onDeleted, onError } = renderButton();

    openDialog();
    fireEvent.click(confirmButton());

    await waitFor(() => expect(onError).toHaveBeenCalledWith(GENERIC_FAILURE));
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
