# @imajin/usage-emitter-claude-code

Reference external `usage.incurred` emitter (#1151): tails Claude Code
session JSONL files and reports token spend into the platform's shared
`usage.incurred` ledger (#1147), the same stream the completions passthrough
(`inference-passthrough`) writes into.

This is the reference implementation for the emitter-registry pattern
(#1151's "(a) Tool exposes its own usage → thin adapter reads it, emits
`usage.incurred`"). A future Warp adapter, or any other tool that exposes its
own usage, follows the same three steps: register an emitter, map the tool's
own log/event format to the ingest body shape, POST it.

## How it works

1. `src/tail.ts` walks `~/.claude/projects/**/*.jsonl`, reading only the
   bytes appended since the last run (a small per-file byte-offset cursor
   persisted to a local state file).
2. `src/mapper.ts` maps each `type: "assistant"` line's `message.usage` to a
   `usage.incurred` ingest row. See that module's header for two Claude Code
   JSONL format quirks it accounts for (one API call can span several JSONL
   lines; `message.id`, not the per-line `uuid`, is the real per-call
   identity and this adapter's dedupe key).
3. `src/client.ts` batches the mapped rows and `POST`s them to
   `{KERNEL_URL}/usage/api/incurred`.
4. The tail cursor is only persisted after every batch posts successfully —
   a failed request leaves it where it was, so the next run re-reads (and
   re-dedupes via `external_id`) rather than silently losing rows.

## One-time setup: register the emitter

Before the first run, register `adapter:claude-code` in the emitter registry
(owner-only; requires the `usage:emitters-manage` scope):

```bash
curl -X PUT "$KERNEL_URL/usage/api/emitters" \
  -H "Authorization: Bearer $YOUR_SESSION_OR_APP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": "adapter:claude-code",
    "reader": "tail-jsonl",
    "cadence": "periodic"
  }'
```

`issuer_did` is forced server-side to your own authenticated DID — you
cannot register an emitter claiming to be issued by someone else. Set
`acting_for` in the body instead if this emitter reports spend on behalf of
a different DID (e.g. a shared/org adapter).

## Running it

```bash
KERNEL_URL=https://kernel.example.com \
USAGE_EMIT_TOKEN=<app-token-jwt-with-usage:emit-scope> \
pnpm --filter @imajin/usage-emitter-claude-code start
```

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `KERNEL_URL` | yes | — | Base URL of the kernel API |
| `USAGE_EMIT_TOKEN` | yes | — | Bearer app-token JWT carrying the `usage:emit` scope |
| `CLAUDE_PROJECTS_DIR` | no | `~/.claude/projects` | Where to look for session JSONL files |
| `USAGE_EMITTER_STATE_FILE` | no | `~/.claude/usage-emitter-claude-code-state.json` | Where the tail cursor is persisted |

## Decisions for review

- **Token TTL vs. run cadence.** App tokens are short-lived (~10 minutes,
  see `docs/guide/service-credentials.md`), and `USAGE_EMIT_TOKEN` is read
  directly from the environment rather than minted here. This adapter is
  meant to be invoked **periodically** (cron / systemd timer) with a freshly
  minted token each run — not as a long-lived daemon, which would need its
  own mint/refresh loop (see `apps/broker-agent/src/token.ts` for that
  pattern, if a future revision wants it).
- **Cache-read tokens folded into `tokens_in`.** `usage.incurred` has no
  separate cache-token columns yet (`quantity`/`unit` land in #1148's own
  migration). `cache_read_input_tokens` is added into `tokens_in` rather
  than dropped — see `src/mapper.ts`'s header.
- **`output_tokens` accuracy is a known Claude Code JSONL limitation, not
  this adapter's bug.** Some Claude Code versions record a placeholder
  `output_tokens` (1–2) on the `assistant` line rather than the final
  streamed count (see `anthropics/claude-code#25941`). This adapter reports
  whatever the JSONL contains; it does not attempt to reconstruct the real
  value from a `result`-type event, which Claude Code does not persist to
  the session file.
- **Cross-batch `message.id` completion.** Within one run, lines sharing a
  `message.id` are collapsed to the last (most complete) one seen. If the
  finalizing line for a `message.id` lands in a *later* run (crossing a
  batch boundary), the row from the earlier, less-complete line has already
  been written and the dedupe key (`ON CONFLICT DO NOTHING`) means the more
  complete line is silently skipped rather than updating it. Acceptable for
  a reference adapter; a future revision could `ON CONFLICT DO UPDATE` when
  the new value is more complete, if this proves material.
