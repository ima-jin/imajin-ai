# RFC-36: Deterministic Hooks — Bridging the Human Out of the Agent Approval Loop

**Status:** Draft
**Authors:** Ryan Veteze, Jin, Oz
**Created:** June 30, 2026
**Related:** RFC-33 (Agent CI Pipeline), RFC-27 (Multi-Agent Coordination), RFC-31 (Agent Execution Sandbox), RFC-13 (Progressive Trust Model), RFC-30 (The Judgment Token Thesis)

---

## Summary

The approval loop between planning (Jin / OpenClaw) and execution (Oz / Warp) is governed by **deterministic hooks at the seams**, not by trust grants or agent latitude. Probabilistic agent work is always sandwiched between deterministic gates; **no probabilistic step advances the pipeline on its own.** The human is bridged out of a seam not by trusting the agent more, but by **promoting** recurring corrections into deterministic configuration — a ratchet validated by chain replay before it goes live.

This is RFC-33 (the agent CI pipeline) generalized into an architecture, with RFC-27's chain, override-tracking, and replay supplying the feedback loop. Governance lives entirely in the coordination/CI plane (config + hooks). It does **not** introduce build-control grants into the product's auth code.

---

## Problem

The brief asks to "bridge Ryan out of the in-between steps" of the build loop: Warp plans → Jin reviews → Ryan goes → execute → review → merge → close. The naive reading is *autonomy through trust* — give a standing grant and let the agent decide. That is exactly the failure we want to avoid: **we do not want agents running probabilistic guesses at scale.**

The reframe is *autonomy through determinism*. An agent step is probabilistic by nature; a configured check is not. The way to remove a human from a seam is to make the decision at that seam **deterministic**, so there is no longer a guess to supervise. The probabilistic surface area shrinks monotonically; the human is left only where genuine novel judgment remains.

Two anti-patterns this RFC explicitly rejects:

1. **Product-code grants.** A scope such as `repo:execute` added to `packages/auth/src/scopes.ts` is the wrong tool and the wrong plane. A scope is a *grant of latitude* — it hands the agent a class of decisions to make probabilistically, which *increases* the probabilistic surface. And `scopes.ts` is the runtime control plane for delegating access to a user's resources (read your media on your behalf), not for governing the development process.
2. **Agent-routed advancement.** Letting a probabilistic agent decide that its own output is good enough to advance past a seam. Advancement is always a deterministic decision.

Concrete motivating failure: `#1192` merged with bare `(#1049, #1003, #1048, #1050)` parentheticals instead of `Closes #N` footers, so GitHub never auto-closed the children. That is a mechanical, fully codifiable correction — precisely the kind of step that should become a deterministic hook and never require a human again.

---

## Principles

1. **Latitude vs determinism.** Grants add latitude (probabilistic). Hooks remove decisions (deterministic). We optimize for the latter.
2. **The sandwich invariant.** Every probabilistic step is preceded by a deterministic gate that decides whether to invoke it and followed by a deterministic gate that validates its output. *Only deterministic gates advance the pipeline.*
3. **Plane separation.** Build-process governance lives in the coordination/CI plane (`.github/workflows/`, `scripts/`, SonarCloud config, a hook-policy file). It never lives in product auth code.
4. **Provenance ≠ correctness.** The chain records *who/what authorized* each transition (RFC-27). Correctness comes from the deterministic predicates plus replay validation — not from the audit trail.
5. **Asymptotic determinism.** "More and more deterministic over time" approaches but never reaches 100%. Novel architecture and judgment stay with agent + human. The escape hatch is the permanent frontier, not a failure.

---

## Anatomy of a hook

A hook is a four-tuple installed at a seam:

| Part | Definition | Must be deterministic? |
|------|------------|------------------------|
| **Trigger** | The seam event that fires the hook (PR opened, `check_suite` completed, plan submitted, merge). | Yes (event-driven) |
| **Predicate** | The condition evaluated to decide the outcome (e.g. "SonarCloud new issues == 0", "closing-keyword footer present", "schema change ⇒ migration file present"). | **Yes — no model in the decision path** |
| **Action** | The deterministic routing taken: invoke an agent with a templated prompt, label, block, require human, advance. | Yes (the routing is fixed; the work it routes to may be probabilistic) |
| **Record** | A signed chain entry (RFC-27) capturing trigger, predicate result, action, and actor identity. | Yes |

Two hook kinds:

- **Gate hook** — predicate decides *advance / block / escalate*. Pure determinism.
- **Route hook** — predicate decides *which agent to invoke* and with what templated input. The invoked work is probabilistic, but the routing decision and the re-gate that validates its output are deterministic, and the loop is bounded (iteration cap → `needs-human`).

---

## The pipeline and the seam map

```
 issue/epic
    │
 [S0] plan-intake gate ──────────────► Jin plans (probabilistic)
    │                                        │
 [S1] plan/PR-shape gate ◄─────────────------┘
    │   (footer, migration-sync, .fair, acceptance gates)
    ▼
  PR opened
    │
 [S2] quality gate (CI · lint · build · SonarCloud)
    │            │ new issues > 0
    │            ▼
    │   [S3] refinement route ─────────► Oz refines (probabilistic, capped ≤3)
    │            │                            │
 [S4] re-gate ◄──┴────────────────------------┘
    │   clean
    ▼
 [S5] merge ───────────────────────────► HUMAN (permanent, for now)
    │
 [S6] close gate (closing-keyword footer resolves children)
```

| Seam | Trigger | Deterministic hook (predicate → action) | Probabilistic work | Advance condition | Stays human |
|------|---------|------------------------------------------|---------------------|-------------------|-------------|
| **S0** plan intake | issue labeled `active` | scope/boundary check → route to planner or escalate | Jin drafts plan | in-scope, no deliberate boundary | novel epic design |
| **S1** plan → PR | plan/PR submitted | shape lint (closing-keyword footer, schema↔migration sync, `.fair`, acceptance gates) → block or pass | — | all checks pass | — |
| **S2** PR → quality | PR opened/updated | CI + `scripts/sonar/phase1-lock-policy.ps1` quality gate → pass or route to S3 | — | new issues == 0 | — |
| **S3** gate → refine | quality gate fail | templated Oz trigger + iteration counter → invoke or escalate | Oz fixes issues | iterations < 3 | after 3 → `needs-human` |
| **S4** refine → re-gate | Oz push | re-run S2 predicate | — | clean | — |
| **S5** merge | `ready-for-review` | (none — human authority) | — | — | **always (deliberate)** |
| **S6** close | merge | parse closing-keyword footer → close children | — | footer present | re-parenting decisions |

The human-facing reductions match RFC-33: Ryan stops being the router for S2→S3 (reading SonarCloud and copy-pasting to Oz) and S3→S4. Merge (S5) and novel design (S0) remain human.

---

## The promotion ladder

Each seam advances independently along this ladder. "Bridging Ryan out" of a seam means moving it to L2 or L3.

| Level | Name | Who advances work across the seam |
|-------|------|-----------------------------------|
| **L0** | Human-routed | Human manually moves work (RFC-33 Phase 1, today) |
| **L1** | Agent-routed, human-gated | A hook routes; a human approves advancement |
| **L2** | Agent-routed, deterministically-gated | A deterministic predicate approves advancement; human only on the `needs-human` escape |
| **L3** | Promoted | The decision is fully codified in config; no agent judgment in the path |

---

## The promotion loop (the missing mechanism)

RFC-27 Phase 5 already records corrections on the chain, and tunes the **router** (still a probabilistic model). What is missing is the loop that takes a stable correction and **removes it from the agent entirely** by codifying it as a deterministic predicate. That loop is what actually climbs the ladder:

```
1. OBSERVE   every override/correction at a seam is a signed chain entry (RFC-27 Phase 5)
2. CLUSTER   group recurring corrections of the same shape → candidates for codification
3. SPECIFY   express the correction as a deterministic predicate (CI check, lint rule, Sonar rule)
4. REPLAY    run the candidate predicate against the historical chain (RFC-27 replay):
             would it have produced the right outcome on the last N transactions?
             measure false-positive / false-negative rates
5. PROMOTE   if within thresholds, merge the predicate into the protected hook config
             → the seam climbs the ladder
6. MONITOR   track the promoted hook's accuracy; demote/refine on regression
```

Each successful promotion deletes one probabilistic decision from the critical path. That is the concrete mechanism by which a human is removed from a seam — not a one-time trust grant, but an accumulation of validated promotions.

---

## Chain replay as the de-risking primitive

RFC-27 frames the chain as a replayable test harness ("`git bisect` for agent behavior"). This RFC uses it as the gate on **step 4** of the promotion loop: a candidate predicate is never promoted on intuition. It is replayed against the recorded history of that seam and must reproduce the correct outcomes within agreed error thresholds before it can govern live traffic. Config changes to existing hooks go through the same replay gate. This is how "use feedback to make the process more deterministic" becomes safe rather than speculative.

---

## Config protection (the one hard boundary)

Deterministic config only delivers determinism if the agents it governs cannot silently rewrite it. The hook-policy surface — `.github/workflows/*.yml`, SonarCloud config, lint/predicate rules, and the deliberate-boundary policy — must be:

- **In-repo and versioned**, so every hook is reviewable and replayable.
- **Protected by CODEOWNERS + branch protection**, requiring human review for any change to a governance path. The planner/executor agents open PRs; without this, a probabilistic agent could route around a deterministic gate by editing the gate.
- **Subject to the replay gate** above for any modification.

This is the single hard, human-owned boundary that the rest of the architecture leans on. It is repo governance, not product code.

---

## Deliberate boundaries (never promoted)

By policy, the determinism ratchet never promotes these to silent/auto. They remain human-gated ("deliberate") regardless of how routine they become:

- Production deploy
- Schema migration applied to prod
- Money movement / settlement
- Changes to the hook-policy / governance config
- Any irreversible action

Execution blast-radius for the probabilistic steps that *are* automated (S3 refinement) is bounded by the iteration cap today, and should be bounded by **RFC-31 (Agent Execution Sandbox)** as that lands. Treat RFC-31 as a prerequisite for taking any *execution* seam to L3.

---

## Identity and authority

Hooks authenticate their actions and sign their chain entries using the **RFC-27 agent-coordination plane**, not product user-resource scopes:

- Agent actors (`@veteze_openclaw_jin`, the Oz/Warp actor, `@veteze_router_jin`) hold DIDs with delegated, scoped *coordination* capabilities — what each agent may do in the pipeline.
- Delegation uses the existing `actingFor` primitive (`resolveActingDid` in `packages/auth/src/acting-did.ts`) and app/app-service tokens (`apps/kernel/src/lib/auth/jwt.ts`), so the authorization chain (Ryan → Jin → Oz) is expressible and auditable.
- **Revocation latency matters at boundaries.** App tokens verify locally with a short TTL and are not revocation-checked on the fast path; for deliberate-boundary actions, route through the instant-revocation (attestation-validate) path rather than the fast path.

The hooks consume these identities to *record and authenticate*; they do not gate the build on product consent scopes.

---

## Phasing

| Phase | Goal | Maps to |
|-------|------|---------|
| **0 — now** | Conventions documented; substrate exists (Actions, SonarCloud, `scripts/check-schema-migration-sync.sh`, `docs/PR-CHECKLIST.md`); human routes all seams (L0). | RFC-33 Phase 1 |
| **1** | Build `quality-gate.yml` (S2/S3/S4) and the S1 plan/PR-shape linter; begin chain-recording overrides. | RFC-33 Phase 2–3, RFC-27 Phase 5 start |
| **2** | Promotion loop operational (observe → cluster → specify → replay → promote); first seams reach L2. | RFC-27 Phase 5 |
| **3** | Hook-policy config protected; deliberate-boundary policy enforced; most mechanical seams at L2/L3; human at S5 merge + boundaries only. | this RFC |
| **4** | Agent DIDs + `.fair` manifests on PRs; every hook firing is a signed attestation; cross-node replay. | RFC-33 Phase 4, RFC-27 Phase 4 |

---

## Scope — in and out

### In scope
- The hook anatomy and the sandwich invariant.
- The seam map for the development pipeline (S0–S6).
- The promotion ladder and the promotion loop.
- Replay-validation as the promotion gate.
- Config protection and the deliberate-boundary policy.
- Chain-recording of seam transitions.

### Out of scope
- Product-side build grants (explicitly rejected — wrong plane, wrong direction).
- Self-merge (S5 stays human for now).
- The router implementation itself (RFC-27).
- The execution sandbox internals (RFC-31 — consumed as a dependency).
- Generalizing the architecture beyond the dev pipeline (later; the pattern is intended to generalize).

---

## Open questions

1. **Policy locus.** One central hook-policy file, or policy distributed across the workflow YAMLs? Central is easier to protect and replay; distributed is closer to the trigger.
2. **Who performs `SPECIFY`?** Human, a dedicated meta-agent, or the router proposing candidates for human confirmation?
3. **Replay corpus + thresholds.** How many historical transactions constitute a confident promotion, and what false-positive / false-negative rates are acceptable per seam?
4. **Demotion.** Automatic demotion on measured regression, or human-triggered only?
5. **RFC-31 dependency.** Is the sandbox a hard prerequisite for L3 on execution seams, or only for specific action classes?
6. **Identity timeline.** When do the Oz and SonarCloud actors get DIDs (RFC-33 Phase 4 / RFC-27), and does the chain-record requirement block earlier phases?

---

## Why this matters

This is RFC-27's thesis applied inward: "the moat is the coordination layer with accountability," and "you don't trust the AI — you verify it." The development pipeline is the first dogfood — the platform's own coordination machinery governing the platform's own build process — and the seam/gate/promotion pattern generalizes to any planning → execution workflow. Autonomy is earned one validated promotion at a time, never granted in a lump.
