# RFC-33: Agent CI Pipeline — Automated Quality Gates

**Status:** Draft
**Authors:** Ryan Veteze, Jin
**Created:** May 23, 2026
**Related:** RFC-27 (Multi-Agent Coordination), RFC-31 (Agent Execution Sandbox), RFC-32 (Agent Protocol Interoperability)

---

## Summary

PRs go through a multi-agent pipeline where each agent has a defined role, identity, and accountability. The human architects. Agents implement, refine, and validate. The human merges.

Today this pipeline exists but the human is the router — manually handing work between agents. This RFC defines the automation layer that removes the human from mechanical coordination while preserving human authority over architecture and merge decisions.

---

## Problem

The current workflow:

1. **Jin (OpenClaw/Opus)** — architecture, design, first-pass implementation → opens PR
2. **Ryan** — reviews, spots issues, routes to Oz
3. **Oz (Warp)** — refinement, mechanical cleanup, SonarCloud fixes → pushes to branch
4. **Ryan** — re-reviews, merges

Steps 2 and 3 are mechanical routing. Ryan shouldn't need to read SonarCloud output and copy-paste it to Oz. The quality gate should be agent-to-agent.

---

## Design

### Pipeline Stages

```
PR opened/updated
  → CI (lint, test, build)
  → SonarCloud analysis
  → Quality Gate check
    → If new issues > 0: trigger refinement agent
    → If clean: ready for human review
  → Human merges
```

### Agent Roles

| Agent | Role | Trigger | Identity |
|-------|------|---------|----------|
| Jin (OpenClaw) | Architecture, design, first-pass code | Human conversation | `did:imajin:...` (agent DID, delegated from @jin) |
| Oz (Warp) | Refinement, mechanical cleanup, missing pieces | API trigger from CI | `Co-Authored-By` today, DID future |
| SonarCloud | Static analysis, quality validation | PR webhook | Service account (no DID yet) |
| GitHub Actions | Orchestrator — connects stages | PR events | Workflow identity |

### Trigger Flow

**GitHub Action: `quality-gate.yml`**

```yaml
on:
  # Runs after CI and SonarCloud complete
  check_suite:
    types: [completed]

jobs:
  quality-gate:
    # 1. Query SonarCloud API for new issues on this PR
    # 2. If issues > 0, call Warp API to trigger Oz
    # 3. Oz prompt includes: PR number, branch, issue list, fix instructions
    # 4. Oz pushes fixes → CI re-runs → quality gate re-checks
    # 5. If clean after N iterations, label PR "ready-for-review"
```

**Warp API Call:**

```typescript
import { OzClient } from '@anthropic-ai/oz-sdk';

const oz = new OzClient({ apiKey: process.env.WARP_API_KEY });

const run = await oz.agent.run({
  prompt: `Review and fix SonarCloud issues on PR #${prNumber} in ima-jin/imajin-ai.
    Branch: ${branch}
    Issues: ${JSON.stringify(issues)}
    Fix all issues. Push to the branch. Do not change functionality.`,
  config: {
    name: 'sonar-refinement',
    // environment, model, etc.
  },
});
```

### Iteration Limit

The pipeline caps at 3 refinement cycles per PR. If Oz can't resolve all issues in 3 passes, the PR gets labeled `needs-human` and Ryan reviews manually. This prevents infinite loops on issues that require architectural decisions.

### Attribution

Each agent's commits carry identity:
- **Today:** `Co-Authored-By: Oz <oz-agent@warp.dev>` in commit messages
- **Future (RFC-27):** Agent DIDs in .fair manifests on every PR. The merge commit carries a manifest showing who contributed what — architect (Jin), refinement (Oz), validation (SonarCloud).

---

## Scope — What's In and Out

### In scope
- GitHub Action that queries SonarCloud API after analysis completes
- Warp API integration to trigger Oz cloud agent runs
- Prompt engineering for the refinement agent
- Iteration limit and `needs-human` escape hatch
- PR labeling for pipeline status

### Out of scope (future)
- Agent DIDs for Oz and SonarCloud (RFC-27 dependency)
- .fair manifests on PRs (RFC-27 + .fair integration)
- Bidirectional communication (Jin ↔ Oz conversation, not just handoff)
- Other quality gates beyond SonarCloud (security scanning, performance benchmarks)
- Self-merging (human always merges for now)

---

## Implementation Path

### Phase 1 — Manual trigger (now)
Ryan triggers Oz manually via Warp UI or CLI. Current workflow, documented.

### Phase 2 — Semi-automated (next)
GitHub Action queries SonarCloud, formats the issue list, but posts it as a PR comment instead of triggering Oz. Ryan copy-pastes to Oz. Removes the "read SonarCloud" step from human.

### Phase 3 — Fully automated (target)
GitHub Action triggers Oz cloud agent directly via API. Human only sees the final clean PR. Merge is still manual.

### Phase 4 — Identity (RFC-27)
Agents get DIDs. .fair manifests on PRs. Full attribution chain. The PR itself becomes a signed record of multi-agent coordination.

---

## Open Questions

1. **Warp cloud agent pricing** — How many runs per month? Cost per run? Need to understand economics before automating.
2. **Oz environment setup** — Does the cloud agent need repo access pre-configured, or is it per-run?
3. **Conflict resolution** — What happens if Oz's fixes break the build? Who retries — the Action, or does it escalate to human?
4. **PR ownership** — If Jin opens a PR and Oz pushes 3 commits to it, who "owns" the PR for review purposes?
5. **Beyond SonarCloud** — Should the quality gate also check for test coverage, bundle size, or other metrics?

---

## Why This Matters

This is the first concrete instance of RFC-27 (Multi-Agent Coordination) applied to the development process itself. The codebase is the coordination surface. GitHub is the message bus. PRs are the transactions. .fair manifests (eventually) are the attribution layer.

If this works for code quality, the same pattern generalizes to any multi-agent workflow: design → implement → review → validate → ship, with humans holding the architecture and merge authority.

The moat isn't the agents. The moat is the coordination layer with accountability.
