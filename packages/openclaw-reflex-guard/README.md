# @imajin/openclaw-reflex-guard

OpenClaw plugin implementing the post-turn instruction-check hook from
[imajin-ai#1252](https://github.com/ima-jin/imajin-ai/issues/1252): a
deterministic outbound-content guard (Layer 1) plus the scaffold for a fuzzy
reflex layer (Layer 2).

## What it does

### Layer 1 — deterministic outbound sealed-term guard (ship-ready)

A pattern/string scan of outbound content against a **configurable** sealed-term
list. No LLM call. Block-or-flag per term, with every trip audit-logged.

- Hooks: `message_sending` (hard block/rewrite seam) and `before_dispatch`
  (dispatch-path seam for channel adapters that bypass `message_sending`).
- **No sealed/sensitive terms are hardcoded in this repo.** The plugin ships
  with an empty term list; real terms are injected via
  `plugins.entries.reflex-guard.config.guard.terms` in `openclaw.json` on the
  operator's own machine. See `config/sealed-terms.example.json` for the shape.
- Each term has its own `action`: `"block"` cancels delivery; `"flag"` only
  audit-logs the trip and lets the message through.
- Every trip is appended to a JSONL audit log (`guard.auditLogPath`, default
  `reflex-guard/audit-log.jsonl`) as `{ ts, termId, surface, action,
  sessionKey? }` — **never** the matched text or the sealed pattern itself.
- Fails **closed**: a scan/handler error blocks the outbound content rather
  than passing it through (the opposite of this codebase's usual fail-open
  convention for non-security hooks — see the PR's "Decisions for review").

### Layer 2 — fuzzy reflex scaffold (default OFF, not the full build)

The warrant-gate → injection-check → own-and-stamp flow from the issue,
scaffolded but not fully live:

- **Warrant gate** (`src/reflex-warrant-gate.ts`): a real, cheap, non-LLM
  heuristic implementation of the four trigger features
  (`external-send`, `artifact-produced`, `commitment-asserted`,
  `direction-changed`).
- **Injection check** (`src/reflex-injection-check.ts`): the LLM-judgment
  step is a **stub** behind the `InjectionChecker` interface — it always
  reports no concerns tripped. The real judgment call is a follow-up once
  `reflex-log.jsonl` has labeled fires to build it against.
- **Own-and-stamp**: `src/reflex-stamp.ts` builds the inline
  `<beta> … [👍/👎]` stamp, capped at 2 surfaced concerns per turn.
- **Log**: `src/reflex-log.ts` appends every *warranted* turn (tripped or
  not) to a JSONL log (`reflex.logPath`, default
  `reflex-guard/reflex-log.jsonl`).
- Wired to `before_agent_finalize` — which can only ask the harness for
  `{ action: "revise" }` (one more model pass) or `{ action: "finalize" }`,
  never a direct rewrite/cancel — behind `reflex.enabled`, **default `false`**.

Feedback capture (parsing 👍/👎 reactions on `<beta>` stamps back into
`reflex-log.jsonl`) is **not** implemented in this PR — see the PR body.

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "reflex-guard": {
        "enabled": true,
        "config": {
          "guard": {
            "enabled": true,
            "terms": [
              { "id": "example-term", "pattern": "REPLACE_WITH_YOUR_SEALED_PHRASE", "action": "block" }
            ],
            "auditLogPath": "reflex-guard/audit-log.jsonl"
          },
          "reflex": {
            "enabled": false
          }
        }
      }
    }
  }
}
```

- **`guard.enabled`** (optional) — explicit opt-out; defaults to `true`.
- **`guard.terms`** (optional) — sealed-term list; empty by default. NEVER
  commit real terms here.
- **`guard.auditLogPath`** (optional) — JSONL path for guard trip records.
- **`reflex.enabled`** (optional) — explicit opt-in for the Layer 2 scaffold;
  defaults to `false`.
- **`reflex.logPath`** (optional) — JSONL path for reflex-log records.

`message_sending` and `before_dispatch` are "Messages and delivery" hooks and
do **not** require `hooks.allowConversationAccess`. `before_agent_finalize`
does — see `docs/plugins/hooks.md` in the OpenClaw host.

## Runtime verification

- `message_sending`'s event/result contract (`{ to, content, ... }` /
  `{ content?, cancel?, cancelReason?, metadata? }`) is confirmed directly
  against `src/plugins/hook-message.types.ts` in openclaw/openclaw.
- `before_dispatch`'s result contract (`{ block?, replyText? }`) is confirmed
  against the hook's introducing PR (openclaw/openclaw#43422) but has shifted
  across releases in the wild. **Verify against your installed runtime**
  (`openclaw plugins inspect reflex-guard --runtime --json`) before relying on
  this seam in production.

## Development

```
pnpm --filter @imajin/openclaw-reflex-guard typecheck
node_modules/.bin/vitest run packages/openclaw-reflex-guard/tests
```
