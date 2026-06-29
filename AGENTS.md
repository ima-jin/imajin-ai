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
