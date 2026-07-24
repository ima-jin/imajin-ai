# RFC-41: The Composable Gate — A Signed-Predicate Reactor Primitive

**Status:** Draft — **falsifiable claim, build deferred**
**Authors:** Ryan Veteze, Jin
**Created:** July 24, 2026
**Discussion:** TBD
**Related:** RFC-07 (Cultural DID — the purest instance), RFC-40 (`did:imajin` Resolution — authority-lineage instance), RFC-32 §4.7 (KYA-OS/AP2 delegation credential), RFC-17 (Governance Primitive), RFC-37 (Corroboration Escrow — candidate fifth instance), RFC-39 (Verifiable Skills — same verify-against-the-record discipline)
**Tracking:** epic #965; artifactagent #16 / #18 / #5 / #40 (the ad-eligibility instance)

---

## 0. Status note — why this RFC does not authorize a build

This RFC **normalizes a pattern we have built ~4 times** and **explicitly defers implementing the abstraction.** It exists to write the shape down precisely enough that the *next* real need can either snap onto it or visibly break it — the break being the valuable outcome.

The honest constraint is stated up front because it is the whole point of filing this now rather than coding it:

> **An abstraction extracted from four instances that all live in the same two heads is not proven. It is proven when a fifth need — ideally one we did not design — either fits the interface cleanly or breaks it.**

All four current instances (delegation, ad-eligibility, cultural DID, consent-tier) were designed within one worldview. That is not four independent confirmations of a shape; it is one worldview expressed four times. The shape *feels* inevitable precisely because we made it feel that way — which is exactly the condition under which premature abstraction feels most justified and is most dangerous.

So RFC-41 is a **falsifiable claim**, in the same discipline as conformance (prove against a runnable test) and RFC-39 (verify against the signed record), pointed this time at our own architectural instinct. An RFC that can only be confirmed and never falsified is a manifesto, not a spec. This one is designed to be broken by instance five.

**Receipt that deferral has been the right call twice already:** `ReactorConfig.condition` exists in `packages/bus/src/types.ts` (`condition?: string; // optional: future use for conditional execution`) and is evaluated **nowhere** (confirmed: absent from `config.ts` / `index.ts` evaluation paths). We designed the hook for gated composition and correctly did not build the evaluator. This RFC does not change that. It specifies what the evaluator *would* be, and waits.

---

## 1. Summary

Across the platform we keep building the same primitive:

> **A signed, scoped predicate — authored by the subject or collective it is about, evaluated at the edge, emitting only a boolean — that can consume other gates' booleans as inputs.**

Not *generalized* (one shape reused). **Composable** — gates take each other as inputs and chain like AND/OR/NOT logic gates in a circuit. Because each edge carries only a signed bit, arbitrary trust circuits can be assembled and the privacy invariant holds at every seam: a downstream gate consumes an upstream boolean **without seeing the inputs that produced it.**

The purest single statement is the **cultural gate** (RFC-07): `belongs-to(subject, context)`, signed by the collective, verifiable by anyone, no central roster. Every other instance is this gate at a different altitude.

---

## 2. The four instances (stable shape, unproven abstraction)

| Instance | Predicate | Author of the condition | Where evaluated | Status in code |
|----------|-----------|-------------------------|-----------------|----------------|
| **Cultural DID** (RFC-07) | `belongs-to(subject, culture)` | the collective | anyone, at the edge | Draft RFC |
| **Delegation / authority lineage** (RFC-40, RFC-32 §4.7) | `derives-authority-from(agent, principal)` within scope | the principal | resource / KYA-OS Verifier | resolver spec'd, delegation rows live (`identity_members`) |
| **Ad-eligibility / consent** (artifactagent #16, #5) | `consented-to-use(household, flight)` | the person (subject-authored) | eligibility store, per-flight | design note |
| **Consent-tier / broker** (bus broker: `consent.ts`, closed #1214/#1196) | `consent-exists(subject, requester, purpose)` | the subject | broker latch, fail-closed | **shipped** — closest to the real primitive today |

Two supporting mechanics that are *part of* the primitive, not separate:
- **Match-without-disclosure** (artifactagent #18) — the rule that a gate emits only a boolean, never its inputs. This is **what makes composition non-leaking.** Without it, chaining gates leaks.
- **Stub / claim** (the Trojan-horse mechanic) — a *pre-signed* membership mark that activates on claim. A cultural gate whose boolean is authored ahead of time and switched on by the subject's claim.

The broker (`consent.ts`) is the honest anchor: it is already `resolve → allow/reject`, **fail-closed**, composing overlapping grants as a union of fields. It is the primitive, built once, for one domain, not knowing it has three siblings.

---

## 3. The proposed primitive (the thing to be falsified)

### 3.1 `Predicate`

```ts
interface Predicate<Ctx = unknown> {
  /** The subject/collective the predicate is ABOUT. */
  subject: string;                 // DID
  /** The context this membership/authority is scoped to. */
  context: Ctx;
  /** The signed condition — authored by subject or collective, NOT by the evaluator. */
  condition: SignedCondition;
  /** Who authored the condition (the invariant lives here). */
  authoredBy: string;              // DID — must be subject or a collective the subject belongs to
}

interface GateVerdict {
  pass: boolean;
  /** Signed attestation of the verdict — this is what a downstream gate consumes. */
  verdict: SignedAttestation;
  /** NEVER the inputs. Match-without-disclosure (artifactagent #18). */
}

type Gate<Ctx = unknown> = (p: Predicate<Ctx>) => Promise<GateVerdict>;
```

Consent/delegation/eligibility/cultural become **implementations** of `Gate`, not four bespoke resolvers.

### 3.2 Wire the dead `condition` field (pipeline → circuit)

Today the bus runs `reactors[]` unconditionally in order. `ReactorConfig.condition` is declared and ignored. The primitive's core move: the chain evaluator resolves a reactor's `condition` to a `GateVerdict.pass` **before** running it.

```ts
// ChainConfig becomes a CIRCUIT when condition is honored:
for (const reactor of chain.reactors) {
  if (reactor.condition) {
    const { pass } = await evaluateGate(reactor.condition, event);
    if (!pass) continue;   // gated out — fail-closed by default
  }
  await runReactor(reactor, event);
}
```

This single change turns `bus_chain_configs` from a pipeline into a **composed gate circuit.** It is the highest-leverage move because the hook is already stubbed.

### 3.3 Verdict-as-input (composability)

A gate's signed boolean is written to event/broker state so a downstream gate reads *the boolean*, never the inputs (#18). That is what lets `eligible AND belongs-to(flight) AND derives-from(principal)` compose without any stage seeing another stage's raw data.

---

## 4. The invariant that keeps it a sovereign gate, not a gatekeeper

**The condition is authored by the subject/collective and evaluated at the edge — never held in one central table.**

A centralized gate and a sovereign gate are the *same logic gate*. The only difference is who authored the condition:
- **Center-authored** condition = surveillance gatekeeper (HAL: "I decide who's in").
- **Subject/collective-authored** condition = sovereign gate (the genie: "the culture already decided and signed it; the edge just reads the mark").

`authoredBy` in the `Predicate` type is where this invariant is enforced: a conformant gate MUST reject a condition whose author is neither the subject nor a collective the subject belongs to. A gate that lets the evaluator author the condition is, by definition, not this primitive — it is the thing this primitive exists to *not* be.

---

## 5. How to falsify this (the point of the RFC)

RFC-41 is confirmed or broken by **instance five** — a real need, not a designed one. Candidates on the board that will test it:

1. **RFC-37 corroboration escrow** — the surfacing gate ("reveal only when an independent account names the same subject"). Does `Predicate` express a gate whose condition is *another gate firing on a different subject*? If it needs a fundamentally different shape (cross-subject correlation, not single-subject membership), the abstraction is one worldview wide.
2. **A Tripian journey-state gate** — "traveler is eligible for this touchpoint." Different domain, not designed by us against this spec.
3. **RFC-17 governance** — role/scope gates. Does governance decompose into composed `Predicate`s or is it categorically different?

**Success is not "all five fit."** Success is that the spec is precise enough that the fifth case *clearly* either fits or breaks — and if it breaks, we learn the abstraction's true width instead of pouring concrete on the rung we happen to be standing on.

---

## 6. Non-goals

- **Not authorizing implementation.** No `evaluateGate`, no `Predicate` package, no `condition`-evaluator ships on the strength of this RFC. Build waits for a fifth need that tests the interface.
- Not deprecating the four bespoke gates. They work. Extraction happens (if ever) when a real consumer can't be served by the bespoke approach.
- Not a new subsystem. If built, it is `bus_chain_configs` + a `condition` evaluator + a `Predicate` interface the existing gates implement — finishing the machine we half-built, not a new one.

---

## 7. Relationship to "it's all becoming configuration"

These are the same observation from two directions. A FLOW is a `bus_chain_configs` row (an ordered chain of reactors). The composable gate says each reactor can be *gated by a signed predicate*, and gate conditions are signed data, not code. So:

> **A product is a composed circuit of signed predicate gates. Configuring the circuit IS building the product.**

The bus is the composition engine; the composable gate is the reactor discipline that makes the chain a *circuit* instead of a pipeline. When (if) §3.2 ships, "it's all becoming configuration" becomes literally true at the gate layer.

---

## 8. Open questions

1. **Is the ladder taller?** The composable gate is where one conversation topped out, not necessarily the ceiling. Is there a rung above it of which *it* is an instance? (Left open on purpose — this RFC does not claim to be bedrock.)
2. **Cross-subject gates** (RFC-37) — does the single-subject `Predicate` shape hold, or does corroboration need a `Predicate` over a *set*?
3. **Signed-condition format** — reuse the attestation/`.fair` signed-markdown pattern, or a distinct `SignedCondition` type?
4. **Where does the evaluator live** — bus core, or a `@imajin/gate` package the bus consumes? (Only relevant if/when built.)
5. **Stiftung boundary** — is the gate primitive protocol-surface (Swiss spec) or reference-implementation (Imajin Inc.)? Consistent with the RFC-20/21 conformance framing.

---

## 9. Related work

- **RFC-07** — Cultural DID: the purest statement of the primitive (`belongs-to`, signed by the collective).
- **RFC-40** — `did:imajin` Resolution: the authority-lineage instance; also the transport/trust split that a gate's verdict relies on.
- **RFC-32 §4.7** — the delegation credential as a signed, scoped, revocable gate condition.
- **RFC-37** — Corroboration Escrow: the leading candidate *fifth instance* / falsifier.
- **RFC-39** — Verifiable Skills: same "verify against the signed record" discipline, applied to capabilities.
- **artifactagent #16 / #18 / #5 / #40** — the ad-eligibility instance + match-without-disclosure (the non-leaking edge) + the evaluator.
- **`packages/bus`** (`consent.ts`, `broker.ts`, `types.ts`) — the shipped anchor and the dormant `condition` hook.

---

*"A centralized gate and a sovereign gate are the same logic gate. The only difference is who wrote the condition."*
