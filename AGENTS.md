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
