# Vault v1→v2 custody migration runbook

Operator procedure for `POST /api/vault/migrate-custody` and its CLI wrapper,
`scripts/migrate-vault-custody.mjs` (#1537, #2311). This document is the
runbook only — it does not authorize running anything against production.
**Execution against prod is Ryan's call**, made separately from this doc.

## Background

`apps/kernel/src/lib/vault/migrate-custody.ts` upgrades `node-sealed` (v1)
vault fields to `delegation-grant` (v2) custody, one field at a time, verifying
each still unseals before moving to the next. The Aug-1 2026 batch run (#1537)
missed 15 live v1 fields — see #2311 for the root cause (the field-selection
step read "latest entry" by array position instead of by the entry's own
`timestamp`, so a few high-write-frequency fields had their true-latest v1
entry hidden behind an older, already-v2-looking entry). That selection is now
timestamp-based, and this runbook adds a **targeted mode** (`--fields`) so a
known, specific set of fields — such as the ones a previous batch missed — can
be migrated and verified independently of the general "next N fields" flow.

## Prerequisites

- An admin session: `KERNEL_ADMIN_COOKIE` set to the full `Cookie` header from
  a logged-in admin browser session (see the script's header comment for the
  exact shape).
- `KERNEL_BASE_URL` pointing at the target kernel (defaults to
  `http://localhost:3000`).
- Under Tier 1 (`VAULT_OWNER_X_PUB`/`VAULT_OWNER_ED_PUB` configured on the
  kernel): the owner agent (`imajin-cli vault serve`) must already be running.
  The canary will catch a dead or absent agent and abort after touching at
  most one field, but a healthy agent still needs to be online to fulfil the
  grants a real run creates.
- Back up the owner key first: `imajin vault backup`. Once an entry is Tier-1
  sealed, losing the owner key loses the secret — there is no other
  recoverable copy.
- `VAULT_PATH` (if the deployment overrides it) is read server-side the normal
  way; this runbook does not change or need to know that value.

## Step 1 — dry run, no `--fields`: see what the general sweep would do

```bash
KERNEL_ADMIN_COOKIE='...' node scripts/migrate-vault-custody.mjs
```

Confirms `totalV1Fields` (the live v1 count right now) and previews the
default "next N fields" plan. Mutates nothing.

## Step 2 — targeted dry run: confirm the exact known set

When migrating a specific, known set of fields — e.g. the ones a prior batch
missed — list them explicitly instead of relying on "the next N":

```bash
KERNEL_ADMIN_COOKIE='...' node scripts/migrate-vault-custody.mjs \
  --dry-run --fields=@./missed-fields.txt
```

`missed-fields.txt` is one field name per line (blank lines and `#`-prefixed
comment lines are ignored). A comma-separated inline list also works:
`--fields=github-oauth:did:...,github-config:did:...`.

The dry-run output prints, per field, the field name, its current owner DID
(truncated to 20 characters), and the planned action (`would-upgrade`) — never
plaintext or key material. A field named in `--fields` with no live v1 entry
right now (already migrated, deleted, or a typo) is reported separately under
"requested but not in the live v1 set", not silently dropped or migrated by
accident.

Review this output before proceeding. If a field the operator expected is
missing from the plan, check the "requested but not in the live v1 set" list.

## Step 3 — canary: migrate one field for real, verify it

Pick a single low-risk field from the confirmed set and apply it alone:

```bash
KERNEL_ADMIN_COOKIE='...' node scripts/migrate-vault-custody.mjs \
  --apply --fields=<one-field-name>
```

The driver already runs its own internal canary-then-batch sequence for any
multi-field run, but doing an explicit single-field apply first, by hand,
gives the operator a second independent checkpoint before committing the rest
of a known-sensitive set. Confirm the connector or feature that reads this
field still works normally afterward.

## Step 4 — apply the rest of the set

```bash
KERNEL_ADMIN_COOKIE='...' node scripts/migrate-vault-custody.mjs \
  --apply --fields=@./missed-fields.txt
```

The driver migrates the canary (the first field in the resolved candidate
list) and verifies it becomes readable before touching the rest; it aborts on
the first per-field verification failure, reporting exactly how far it got. A
field that upgrades but never re-verifies is left as a `delegation-grant`
entry pending a grant, not silently reverted — investigate before re-running
`--apply` for that field.

## Idempotency and reruns

Every call re-scans the vault fresh. A field already migrated to
`delegation-grant` custody no longer appears in the live v1 set, so re-running
the exact same `--fields` list (or the untargeted sweep) after a successful
apply is a no-op: `candidateCount` drops to 0 for anything already done, and
nothing is re-migrated or re-granted.

## What this runbook does not cover

- Per-environment `VAULT_PATH` splitting — tracked separately in #2357.
- Key rotation — tracked separately in #2354.
- A reconnect UX for a field that ends up `pending-grant` — out of scope per
  #2311; that is a Tier 1 owner-agent liveness question, not a migration bug.
