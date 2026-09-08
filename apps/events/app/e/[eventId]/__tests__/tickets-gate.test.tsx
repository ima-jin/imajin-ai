// @vitest-environment jsdom
/**
 * TicketsGate postMessage origin verification (#2065 / S2819).
 *
 * TicketsGate unlocks ticket purchasing once a required Dykil survey posts
 * `{ type: 'survey-completed', surveyId }` back to the parent window. Before
 * #2065 it acted on any message with that shape regardless of sender — these
 * tests pin that only a message from the expected Dykil origin can unlock it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { TicketsGate } from '../tickets-gate';

const SURVEY_ID = 'survey-1';
const GATED_TEXT = 'Complete the registration form first';
const CHILD_TEXT = 'Gated content';

function installFetch(completed: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ completed }) }) as unknown as Response),
  );
}

function renderGate() {
  render(
    <TicketsGate surveysRequired initialCompleted={false} requiredSurveyIds={[SURVEY_ID]}>
      <div>{CHILD_TEXT}</div>
    </TicketsGate>,
  );
}

function postSurveyCompleted(origin: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      data: { type: 'survey-completed', surveyId: SURVEY_ID },
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('TicketsGate — postMessage origin verification', () => {
  it('renders gated (not the children) before any survey-completed message', () => {
    installFetch(true);
    renderGate();

    expect(screen.getByText(GATED_TEXT)).toBeDefined();
    expect(screen.queryByText(CHILD_TEXT)).toBeNull();
  });

  it('ignores a survey-completed message from an unexpected origin', async () => {
    installFetch(true);
    renderGate();

    postSurveyCompleted('https://evil.example.com');

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(GATED_TEXT)).toBeDefined();
    expect(localStorage.getItem(`survey_${SURVEY_ID}_completed`)).toBeNull();
  });

  it('unlocks the children on a survey-completed message from the Dykil origin', async () => {
    installFetch(true);
    renderGate();

    // DYKIL_URL resolves to a same-origin relative path in this test
    // environment (no NEXT_PUBLIC_* overrides set), so window.location.origin
    // is the legitimate sender origin here.
    postSurveyCompleted(window.location.origin);

    await waitFor(() => expect(screen.getByText(CHILD_TEXT)).toBeDefined());
    expect(screen.queryByText(GATED_TEXT)).toBeNull();
  });
});
