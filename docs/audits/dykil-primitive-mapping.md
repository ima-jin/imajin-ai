# Dykil — primitive mapping

Refs #2519 (step 1 of 5) · Part of #1985 · Companion to
[`dykil-entanglements.md`](./dykil-entanglements.md)

Dykil is not a template fork. It dissolves into three kernel primitives:

- **Survey definition = signed document** (a media asset owned by the survey owner's DID).
- **Response = attestation** ("DID X said Y about survey `docHash`, signed").
- **Ticket-holder check = composable gate** (the events app answers a boolean; dykil never reads
  ticket data).

Source of the model: Ryan's ruling on #1985 (DECISION #1985→c: zero tables, no schema migrations).
Class (a)/(b) labels refer to the entanglement audit. Gap issues are the blockers listed there.

## 1. Signed documents

The survey definition is a JSON document (`dykil.survey/v1`) stored as a media asset. The kernel
signs the asset's `.fair` manifest on the owner's behalf (`ContentSigner`).

| Original (`dykil.surveys` column) | Becomes |
|---|---|
| `id` (`survey_…`) | The media asset id. The legacy id is not preserved: see "Legacy ids" below |
| `did` | Asset owner and `ownerDid` in the document. The owner is the attestation `subject_did` for responses |
| `handle` | Dropped. Derived from the owner DID; the handle route needs #2397 |
| `title`, `description`, `fields`, `settings`, `type`, `status` | Same-named fields in the document body |
| `created_at`, `updated_at` | `createdAt`, `updatedAt` in the document body |
| `status` draft / published / closed | `status` in the body. Public or private visibility is the asset's `.fair` access level, which cannot change after creation (**#2535**) |

Behaviour notes:

- Editing a survey replaces the asset content, which changes its content hash. Responses attest the
  `docHash` they were given, so each response is bound to the exact definition it answered. The
  original app had no such binding.
- Deleting a survey deletes the asset. Responses are the respondents' signed records and are not
  cascade-deleted, unlike the original `ON DELETE CASCADE`. This is an intended behaviour change.
- Survey-owner checks (the owner-only `PUT`, `DELETE`, `GET /responses`) become asset ownership
  enforced by the kernel plus the caller's DID, not an app-side `survey.did === did` comparison.

## 2. Attestations

Each response is one attestation issued to `POST /auth/api/attestations`.

| Original (`dykil.survey_responses` column) | Becomes |
|---|---|
| `id` (`response_…`) | Attestation id |
| `survey_id` | `context_id` (the survey asset id), `context_type: dykil.survey` |
| (survey owner) | `subject_did` |
| `respondent_did` | `issuer_did`, who must sign. Guests have no DID: **#2536** |
| `ticket_id` | `payload.ticketId`. An indexed reference is needed for lookup: **#2534** |
| `answers` | `payload.answers` |
| (none) | `payload.docHash`, `payload.provenance` |
| `created_at` | `issued_at` |

Two provenances stay distinguishable in the data:

- `respondent-signed`: the respondent's own key signed it (delegated attestation, #2394).
- `node-witnessed-legacy-import`: a one-time backport of a pre-migration row that was never
  respondent-signed. Signed by the app's own registered DID, worded as a witness claim, never
  upgraded. Attestation types: `dykil/survey-response` and `dykil/survey-response-legacy-import`.

Reads:

| Original read | Becomes | Needs |
|---|---|---|
| Owner lists responses for a survey | `GET /api/attestations?subject_did=<owner>&type=…&context_id=<survey>` | #2396, #2533 |
| "Has this caller responded?" | same list filtered by `issuer_did` | forward the caller's token (reads are `disclosure_scope`-gated) |
| "Which response belongs to ticket T?" (events, 10 raw SQL sites) | list filtered by an indexed reference | #2534 |

Open point, not a gap: the original upserted a response per (survey, respondent). Attestations are
immutable. The kernel has supersession chains (`history_of`). This audit did not verify that
`POST /api/attestations` accepts a supersedes link for a third-party type. Step 2 (#2521) must decide
how `multipleResponses` and "edit my answer" behave and confirm the kernel call; file a gap if it does
not exist.

## 3. Composable gates

A gate is a boolean question one app answers for another. Dykil asks; it never receives rows.

| Gate | Asked of | Source today | Becomes |
|---|---|---|---|
| Ticket-holder: does DID X hold a ticket for event Y | events app | `by-ticket/[ticketId]` plus `ticket_id` column | `settings.eventId` on the survey document; `respond` calls the gate and answers 403 on false. Endpoint: **#2395**. Until it exists, ticket-scoped surveys return 501 |
| Published | the document itself | `status !== 'published'` check | `status` in the document body |
| One response per respondent | the attestation list | `multipleResponses` plus upsert | issuer-filtered attestation lookup |
| Authenticated respondent | the kernel | `requireAuth` vs optional `getSession` | `authenticate()`; guest path needs **#2536** |

## 4. Route-by-route

| Route in `apps/dykil` | Primitive | Gaps |
|---|---|---|
| `POST /api/surveys` | create signed document | none |
| `GET /api/surveys`, `GET /api/surveys/mine` | list the caller's survey documents (no `dids=` list) | none |
| `GET /api/surveys/:id` | read the document; non-owners see published only | #2535 for true draft privacy |
| `PUT /api/surveys/:id` | replace document content | none |
| `DELETE /api/surveys/:id` | delete the asset | none |
| `POST /api/surveys/:id/respond` | respondent-signed attestation, ticket gate if `eventId` | #2395, #2536 |
| `GET /api/surveys/:id/responses` | owner attestation listing | #2396, #2533 |
| `GET /api/surveys/:id/responses/check` | issuer-filtered lookup | #2534 for the ticket form |
| `GET /api/surveys/:id/responses/by-ticket/:ticketId` | removed; replaced by the gate for dykil and by the indexed reference for events | #2395, #2534 |
| `GET /api/surveys/handle/:handle` | stub in `apps/dykil` (returns an empty list) | #2397 |
| `/api/health`, `/api/spec` | app-local | none |

Pages (`create`, `dashboard`, `survey/[id]/results`, `[handle]`, `[handle]/[surveyId]`,
`(bare)/embed/[surveyId]`, landing) stay app logic: SurveyJS rendering, validation, aggregation,
CSV export, and the iframe plus `postMessage('survey-completed')` protocol events relies on. They
read and write through the routes above.

## 5. Table disposition

Per the step-3 and step-5 instruction to decide per table whether a dykil table stays in the kernel:

| Table | Kernel-owned? | Disposition |
|---|---|---|
| `dykil.surveys` | No. Only dykil writes it | Not kept. Becomes signed documents. Rows are imported in step 4 (#2522), then the table is dropped in step 5 (#2523) |
| `dykil.survey_responses` | No. Only dykil writes it; events reads it | Not kept. Becomes attestations (`node-witnessed-legacy-import` for history). Dropped in step 5 only after events stops reading it (R1: #2534, #1988) |

No dykil table remains in the kernel after step 5.

## 6. Legacy ids

`events.events.registration_form_id` stores a legacy dykil survey id. The rebuilt survey id is the
media asset id. Step 4 must either re-point that events-owned column to the new asset id or keep a
legacy-id alias, and the legacy import must record the old-to-new id map so the repoint is
mechanical. This is an events data migration, not a kernel gap.
