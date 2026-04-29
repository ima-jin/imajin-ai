# Scripts

Utility scripts for the Imajin monorepo.

## Content Matrix Generator

**File:** `build-matrix.mjs`

Walks `docs/articles/` and `docs/rfcs/`, parses frontmatter, validates it against the convention in `docs/CONVENTIONS.md`, and emits three cross-referenced index files.

### Run

```bash
pnpm docs:matrix
```

Or directly:

```bash
node scripts/build-matrix.mjs
```

### Outputs

| File | Description |
|------|-------------|
| `docs/MATRIX.md` | Topic-grouped table: Topic → Essays → RFCs → Issues → PRs → Packages |
| `docs/INDEX.md` | Flat alphabetical list of every artifact with metadata and cross-refs |
| `docs/.matrix.json` | Machine-readable graph (used by future PRs and the public site) |

All generated files include an `<!-- AUTO-GENERATED … -->` header and should not be edited by hand.

### Validation

The generator validates every file against the schema in `docs/CONVENTIONS.md`:

- Required fields (`title`, `type`) must be present
- `type` must be `essay`, `rfc`, or `adr`
- `status` must be `draft`, `shipped`, or `superseded`
- `rev` must be a number
- `topics` must be an array
- `refs` sub-keys must be known (`rfcs`, `issues`, `prs`, `packages`, `essays`, `external`)
- No unknown top-level keys

Invalid frontmatter prints a clear error and exits with code 1.

### Extending

To add a new refs type:

1. Add the key to `ALLOWED_REFS_KEYS` in `build-matrix.mjs`
2. Add validation logic in the `validate()` function
3. Update `emitMatrix()`, `emitIndex()`, and `emitJson()` to render it
4. Document it in `docs/CONVENTIONS.md`

To add a new topic:

1. Add it to the `TOPIC_MAP` in `scripts/backfill-matrix-frontmatter.mjs`
2. Document it in `docs/CONVENTIONS.md`

## Backfill Script

**File:** `backfill-matrix-frontmatter.mjs`

One-time script used to backfill frontmatter on existing essays and RFCs. Normalizes legacy formats (e.g., `status: "POSTED"` → `status: shipped`, inline RFC headers → YAML frontmatter) and adds best-effort topic tagging and cross-ref extraction.

This script is idempotent — running it twice on the same file produces the same output.

```bash
node scripts/backfill-matrix-frontmatter.mjs
```

## Other Scripts

See individual script files for usage. Most accept `--help` or have inline comments.
