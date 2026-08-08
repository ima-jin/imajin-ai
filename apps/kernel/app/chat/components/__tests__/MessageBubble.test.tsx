// @vitest-environment jsdom
/**
 * MessageBubble dual attribution (#1673).
 *
 * A message sent through `X-Acting-For` delegation belongs to the human but was
 * typed by an agent. The bubble is the only place a reader ever learns that, so
 * what is pinned here is that the composer is named whenever `composedBy` is
 * set — including on the reader's own messages and inside a run of consecutive
 * messages, where the sender label is otherwise folded away — and that it never
 * appears on a message the sender typed themselves.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MessageBubble } from '../MessageBubble';

const HUMAN = 'did:imajin:user:ryan0000000000ab';
const AGENT = 'did:imajin:agent:jin000000000000cd';

type Props = Parameters<typeof MessageBubble>[0];

function baseMessage(overrides: Partial<Props['message']> = {}): Props['message'] {
  return {
    id: 'msg_1',
    conversationId: 'did:imajin:dm:abc',
    fromDid: HUMAN,
    content: { type: 'text', text: 'test — ignore, verifying send_dm routing' },
    contentType: 'text',
    replyTo: null,
    createdAt: '2026-08-06T12:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function renderBubble(overrides: Partial<Props> = {}) {
  render(
    <MessageBubble
      message={baseMessage()}
      isOwn={false}
      senderLabel="Ryan"
      showSenderLabel
      onReply={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      reactions={[]}
      onReactionToggle={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('non-delegated message', () => {
  it('names the sender alone', () => {
    renderBubble();

    expect(screen.getByText('Ryan')).toBeDefined();
    expect(screen.queryByText(/transcribed by/)).toBeNull();
  });

  it('keeps folding the sender label away on consecutive messages', () => {
    renderBubble({ showSenderLabel: false });

    expect(screen.queryByText('Ryan')).toBeNull();
  });
});

describe('delegated message', () => {
  it('names the composing agent alongside the sender', () => {
    renderBubble({
      message: baseMessage({ composedBy: AGENT }),
      composedByLabel: 'Jin',
    });

    expect(screen.getByText('Ryan')).toBeDefined();
    expect(screen.getByText('· transcribed by Jin')).toBeDefined();
  });

  it('attributes the reader their own delegated message and names who typed it', () => {
    renderBubble({
      isOwn: true,
      message: baseMessage({ composedBy: AGENT }),
      composedByLabel: 'Jin',
    });

    expect(screen.getByText('You')).toBeDefined();
    expect(screen.getByText('· transcribed by Jin')).toBeDefined();
  });

  it('shows the attribution even when the sender label would be folded away', () => {
    renderBubble({
      showSenderLabel: false,
      message: baseMessage({ composedBy: AGENT }),
      composedByLabel: 'Jin',
    });

    expect(screen.getByText('Ryan')).toBeDefined();
    expect(screen.getByText('· transcribed by Jin')).toBeDefined();
  });

  it('falls back to a DID suffix rather than dropping the attribution', () => {
    renderBubble({ message: baseMessage({ composedBy: AGENT }) });

    expect(screen.getByText(`· transcribed by ${AGENT.slice(-8)}`)).toBeDefined();
  });

  it('spells out both roles for assistive tech', () => {
    renderBubble({
      message: baseMessage({ composedBy: AGENT }),
      composedByLabel: 'Jin',
    });

    expect(screen.getByTitle('Composed by Jin on behalf of Ryan')).toBeDefined();
  });
});
