# imajin-ai project rules

## GitHub CLI on Windows (PowerShell)

**NEVER** pass multi-line body text inline to `gh` commands on Windows. PowerShell 5.1 mangles multi-line strings and backtick/quote escaping at `&&` boundaries, producing garbled PR and issue bodies.

### Always use the file-based pattern:

**Step 1 — write the body to a temp file** using the `create_file` tool:
```
C:\Users\RyanVeteze\AppData\Local\Temp\gh-body.md
```

**Step 2a — for `gh issue create` or `gh pr create`**, use `--body-file`:
```powershell
gh issue create --title "..." --body-file "C:\Users\RyanVeteze\AppData\Local\Temp\gh-body.md"
gh pr create --title "..." --body-file "C:\Users\RyanVeteze\AppData\Local\Temp\gh-body.md"
```

**Step 2b — for `gh pr edit`, `gh issue edit`, or any PATCH operation**, use Python to encode to JSON then `gh api`:
```powershell
python -c "import json; body=open(r'C:\Users\RyanVeteze\AppData\Local\Temp\gh-body.md',encoding='utf-8').read(); json.dump({'body':body},open(r'C:\Users\RyanVeteze\AppData\Local\Temp\gh-body.json','w',encoding='utf-8'))"
gh api --method PATCH /repos/OWNER/REPO/pulls/NUMBER --input "C:\Users\RyanVeteze\AppData\Local\Temp\gh-body.json" --jq '.number'
```

This applies to ALL `gh` body content: PR descriptions, issue bodies, PR edits, and issue edits.

## Viewing GitHub Issues

The default `gh issue view` command fails with a GraphQL deprecation error due to Projects (classic). **ALWAYS** use `--json` with explicit fields instead:

```powershell
gh issue view {issueNum} --repo ima-jin/imajin-ai --json number,title,body,state,labels,assignees,author,createdAt,comments
```

This applies to any `gh issue view` call in this repo — never use the plain `gh issue view {issueNum}` form.
## Git worktree isolation

**ALWAYS** work in a dedicated git worktree for any task that involves creating or modifying files. Never `git checkout` in the main working directory (`D:\Projects\imajin\imajin-ai`). That directory is the shared checkout — switching branches there clobbers every other concurrent session.

### Setup at the start of every session

**Step 1 — create a worktree off `main`** for the branch you are working on:
```powershell
git worktree add ../wt-<branch-slug> -b <branch-name> origin/main
```
If the branch already exists on the remote, omit `-b`:
```powershell
git worktree add ../wt-<branch-slug> <branch-name>
```

**Step 2 — do all work inside that directory:**
```powershell
cd ../wt-<branch-slug>
```
All file reads, edits, commits, and pushes happen here. Never touch the main checkout.

**Step 3 — clean up after the PR merges:**
```powershell
git worktree remove ../wt-<branch-slug>
```

### Naming convention

Use the issue/PR number as the slug, e.g.:
- Issue #1198 → `../wt-1198`
- Branch `feat/18-discord-connector` → `../wt-18`

### Why this matters

All agent sessions share the same machine and the same `D:\Projects\imajin\imajin-ai` directory. A `git checkout` in that directory instantly changes the working tree for every other session running concurrently, causing branch confusion, stale file reads, and CI failures from commits landing on the wrong branch — exactly what happened with the inference engine work ending up in PR #1284 instead of its own PR.

## Issue & label conventions

Repo conventions (issue-label taxonomy + lifecycle rules) are canonical in
**[`ima-jin/conventions`](https://github.com/ima-jin/conventions)** — consumed, not forked. This repo carries the
`universal` **and** `platform` label sets.

**Seed / reconcile labels** (idempotent):
```bash
# from a checkout of ima-jin/conventions
scripts/init-taxonomy.sh ima-jin/imajin-ai --set universal --set platform
```

**Lifecycle rules** (full text: `ima-jin/conventions/ISSUE-CONVENTIONS.md`):
- `Closes #N` / `Fixes #N` in a PR is the **only** thing that auto-closes an issue — a body mention or `Phase N — #N:`
  closes nothing.
- Don't close-and-icebox real ideas — a genuine idea not being worked now stays **open** (shelved), not closed.
- Use GitHub's **native sub-issues / blocked-by** (GraphQL `addSubIssue` / `addBlockedBy`) over `- [ ]` body checklists.
- Labels are for **type/topic**; Status/Priority/Vertical live on the org [Roadmap board](https://github.com/orgs/ima-jin/projects/5), not as labels.

## Versioning (#2285)

**Feature PRs never touch a `package.json` `"version"` field.** Tag is truth: `scripts/build.sh` derives the displayed build version from `git describe --tags --match 'v[0-9]*'` (#2287), and every `package.json` version across the workspace (root + every `apps/*`/`packages/*` manifest) is bumped **only** by the Release workflow, in lockstep, via a normal reviewed PR. A feature PR that bumps any version field — even by accident, even just one package — is rejected by CI's "CI Guards" job (`scripts/ci-guard-version-bump.mjs`), unless its head commit message starts with `release:` (the one shape of commit the Release workflow itself produces). See `docs/npm-publishing.md` for the full mechanism.

## Deploy guardrails

**NEVER `git pull` on the prod box to deploy, and never `git tag`/`git push` a version tag by hand.** Cutting a release is a three-step, fully automated pipeline — no bypass token, no manual tagging, no new approval gate beyond the one that already exists:
1. **Dispatch the Release workflow:** `gh workflow run release.yml -f bump=minor` or `-f bump=patch` (or the GitHub Actions UI). It bumps every `package.json` in lockstep and opens a normal PR (`release: vX.Y.Z`) into `main` — it never pushes to `main` directly.
2. **Merge that PR** like any other reviewed PR, keeping its `release: vX.Y.Z` commit message intact.
3. **`tag-release.yml` takes it from there, automatically:** on the resulting push to `main`, it tags the merge commit `vX.Y.Z` and dispatches `deploy-prod.yml` against that tag — which still requires the `production` GitHub Environment's manual reviewer approval (see `deploy-prod.yml`), exactly like every other prod deploy. Nothing in this pipeline bypasses that gate or main's branch protection.

**Re-deploying an already-tagged/main commit** (no new version, e.g. redeploying after an infra fix): `gh workflow run deploy-prod.yml -f ref=main` (or the GitHub Actions UI).

A manual `git pull` skips `build-changed.sh`, migrations, `reap-orphans`, and `pm2 restart`. The built `.next` stays stale and build failures are invisible (no failed CI run to inspect).
