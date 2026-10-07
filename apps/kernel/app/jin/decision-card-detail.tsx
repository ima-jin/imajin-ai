'use client';

/**
 * Inbox rendering of a DecisionCard v1 (`kind: 'decision:card'`, #2323) —
 * the `decision` source renderer for `operator-approvals-panel.tsx`.
 *
 * Two pieces, matching the panel's `renderDetail` / `renderPendingActions`
 * split:
 *   - {@link DecisionCardDetail}: header (subject link + the one-line
 *     question), the `ev:` key/value strip, and — once decided — the
 *     chosen option.
 *   - {@link DecisionCardOptions}: the a/b/c… countersign buttons, the
 *     recommended one marked inline with its `rec` reason, plus a "None of
 *     these" button that keeps the existing `reject` semantics.
 *
 * Everything here is display-only: choosing an option calls back into the
 * panel's existing `handleDecide` (signature + POST to the existing
 * decision route), so no polling/auth/signing plumbing lives in this file.
 */
import type { ReactNode } from 'react';
import {
  decisionCardChoicePayload,
  decisionCardEvidenceFields,
  findChosenOption,
  isSafeHttpUrl,
  type DecisionCardView,
} from '@/src/lib/decisions/view';

function SubjectLink({ subject }: Readonly<{ subject: DecisionCardView['subject'] }>) {
  // `subject.url` is untrusted adapter-supplied JSON — only an http(s) URL
  // ever becomes an href; anything else renders as plain text.
  if (!isSafeHttpUrl(subject.url)) {
    return <span className="font-mono text-sm text-gray-200">{subject.ref}</span>;
  }
  return (
    <a
      href={subject.url}
      target="_blank"
      rel="noopener noreferrer"
      className="font-mono text-sm text-blue-300 hover:text-blue-200 underline"
    >
      {subject.ref}
    </a>
  );
}

/** `ev:` fields as a compact key/value strip — a missing field shows `?` as-is (missing is data). */
function EvidenceStrip({ evidence }: Readonly<{ evidence: DecisionCardView['evidence'] }>) {
  return (
    <dl data-testid="decision-ev" aria-label="Evidence" className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-500">
      {decisionCardEvidenceFields(evidence).map(({ key, value }) => (
        <div key={key} data-testid={`decision-ev-${key}`} className="flex gap-1">
          <dt className="uppercase tracking-wide">{key}</dt>
          <dd className="font-mono text-gray-300">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ChosenOption({ view, chosenLetter }: Readonly<{ view: DecisionCardView; chosenLetter: string }>) {
  const option = findChosenOption(view.options, chosenLetter);
  return (
    <div data-testid="decision-chosen" className="text-xs text-gray-500">
      <span className="uppercase tracking-wide mr-2">Chosen</span>
      <span className="font-mono text-green-300">{chosenLetter}</span>
      {option && <span className="text-gray-300"> — {option.label}</span>}
    </div>
  );
}

/**
 * Card body. `chosenLetter` is the decided card's recorded option (the
 * decision payload's `mode`) — null while pending, or when the card was
 * decided with something that isn't an option letter (e.g. rejected).
 */
export function DecisionCardDetail({
  view,
  chosenLetter,
}: Readonly<{ view: DecisionCardView; chosenLetter: string | null }>) {
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <SubjectLink subject={view.subject} />
        <p className="text-sm text-gray-200">{view.question}</p>
      </div>
      <EvidenceStrip evidence={view.evidence} />
      {chosenLetter && <ChosenOption view={view} chosenLetter={chosenLetter} />}
    </div>
  );
}

const OPTION_BUTTON_BASE =
  'px-3 py-1.5 rounded text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

function optionButtonClass(isRec: boolean): string {
  return isRec
    ? `${OPTION_BUTTON_BASE} bg-green-700/70 text-green-100 hover:bg-green-600/70 ring-1 ring-green-500/50`
    : `${OPTION_BUTTON_BASE} bg-gray-700 text-gray-200 hover:bg-gray-600`;
}

function OptionRow({
  option,
  isRec,
  recWhy,
  busy,
  onChoose,
}: Readonly<{
  option: DecisionCardView['options'][number];
  isRec: boolean;
  recWhy: string;
  busy: boolean;
  onChoose: (letter: string) => void;
}>) {
  return (
    <li data-testid={`decision-option-${option.letter}`} className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onChoose(option.letter)} disabled={busy} className={optionButtonClass(isRec)}>
          {option.letter}) {option.label}
        </button>
        {isRec && (
          <span data-testid="decision-rec" className="text-xs text-green-300">
            <span className="px-1.5 py-0.5 mr-1.5 rounded bg-green-900/60 font-medium">rec</span>
            {recWhy}
          </span>
        )}
      </div>
      {option.consequence && <p className="text-xs text-gray-500 pl-1">{option.consequence}</p>}
    </li>
  );
}

/**
 * The pending-state action row (`renderPendingActions` hook, #2293): one
 * countersign button per option plus "None of these". `onDecide` is the
 * panel's own decision handler — an option goes out as the existing
 * `approve` decision with the letter as its `mode`
 * ({@link decisionCardChoicePayload}); "None of these" is the unchanged
 * `reject`.
 *
 * `view` is null when the row's `detail` isn't a usable card — only
 * "None of these" is offered then, since there is no option letter that
 * could honestly be signed.
 */
export function DecisionCardOptions({
  view,
  busy,
  onChoose,
  onNone,
}: Readonly<{
  view: DecisionCardView | null;
  busy: boolean;
  onChoose: (payload: ReturnType<typeof decisionCardChoicePayload>) => void;
  onNone: () => void;
}>): ReactNode {
  return (
    <div className="space-y-2 pt-1">
      {view && (
        <ul className="space-y-2">
          {view.options.map((option) => (
            <OptionRow
              key={option.letter}
              option={option}
              isRec={option.letter === view.rec.letter}
              recWhy={view.rec.why}
              busy={busy}
              onChoose={(letter) => onChoose(decisionCardChoicePayload(letter))}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onNone}
        disabled={busy}
        className={`${OPTION_BUTTON_BASE} bg-red-900/40 text-red-300 hover:bg-red-800/60`}
      >
        None of these
      </button>
    </div>
  );
}
