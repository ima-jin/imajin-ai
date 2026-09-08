// @vitest-environment jsdom
/**
 * SurveyAccordion postMessage origin verification (#2065 / S2819).
 *
 * The accordion embeds a Dykil survey iframe and listens for
 * `window.addEventListener('message', ...)` to know when the survey is
 * completed. Before #2065 it trusted any message whose `event.source`
 * matched the iframe's contentWindow, without checking `event.origin` —
 * these tests pin that a message must come from both the expected Dykil
 * origin AND this accordion's own iframe before it is acted on.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { SurveyAccordion } from '../survey-accordion';

function installFetch() {
  // fetchStatus() is best-effort and swallows failures — a rejected fetch is
  // the simplest stub that keeps the component from making a real request.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
}

function renderAccordion(onComplete = vi.fn()) {
  render(
    <SurveyAccordion
      eventId="event-1"
      surveyId="survey-1"
      surveyTitle="Test Survey"
      ticketId="ticket-1"
      defaultExpanded
      onComplete={onComplete}
    />,
  );
  return { onComplete };
}

async function getIframe() {
  return (await screen.findByTitle('Test Survey')) as HTMLIFrameElement;
}

function postSurveyCompleted(iframe: HTMLIFrameElement, origin: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      origin,
      source: iframe.contentWindow,
      data: { type: 'survey-completed', answers: { q1: 'yes' } },
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('SurveyAccordion — postMessage origin verification', () => {
  it('ignores a survey-completed message from an unexpected origin', async () => {
    installFetch();
    const { onComplete } = renderAccordion();
    const iframe = await getIframe();

    postSurveyCompleted(iframe, 'https://evil.example.com');

    // Give any (incorrect) async handling a tick to run before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('accepts a survey-completed message from the same origin as the Dykil embed', async () => {
    installFetch();
    const { onComplete } = renderAccordion();
    const iframe = await getIframe();

    // DYKIL_URL resolves to a same-origin relative path in this test
    // environment (no NEXT_PUBLIC_* overrides set), so window.location.origin
    // is the legitimate sender origin here.
    postSurveyCompleted(iframe, window.location.origin);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('ignores a same-origin message whose source is not this iframe', async () => {
    installFetch();
    const { onComplete } = renderAccordion();
    await getIframe();

    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: null,
        data: { type: 'survey-completed', answers: { q1: 'yes' } },
      }),
    );

    await new Promise((r) => setTimeout(r, 0));
    expect(onComplete).not.toHaveBeenCalled();
  });
});
