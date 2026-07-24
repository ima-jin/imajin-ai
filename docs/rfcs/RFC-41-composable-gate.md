# RFC-41: The Composable Gate — A Signed-Predicate Reactor Primitive

**Status:** Draft — **pattern confirmed (5 instances), abstraction deferred by priority, not doubt**
**Authors:** Ryan Veteze, Jin
**Created:** July 24, 2026
**Discussion:** TBD
**Related:** RFC-07 (Cultural DID — the purest instance), RFC-40 (`did:imajin` Resolution — authority-lineage instance), RFC-32 §4.7 (KYA-OS/AP2 delegation credential), RFC-17 (Governance Primitive), RFC-37 (Corroboration Escrow — candidate fifth instance), RFC-39 (Verifiable Skills — same verify-against-the-record discipline)
**Tracking:** epic #965; artifactagent #16 / #18 / #5 / #40 (the ad-eligibility instance)

---

## 0. Status note — why this RFC does not authorize a build

This RFC **normalizes a pattern we have now built five times** and **defers implementing the abstraction — by priority, not by doubt about the shape.** It exists to write the shape down precisely enough that when convergence is worth the focus, each existing instance can convert to the abstraction and either snap onto it or visibly break it — the break being the valuable outcome.

**Why deferred (updated 2026-07-24):** the pattern is no longer unproven — `supply.*` (the Catalyst/AgriFortress chain, actively shipping on the Aug 17 XPRIZE clock: `supply.declared`/`supply.received`/`settled` reactors, #1375/#1384) is the fifth bespoke instance. The shape is confirmed. What is deferred is the **exit**: a strangler-fig migration where each of the five instances converts to the `Predicate` interface *on its own clock*, and a convergence epic closes only when all five run on the abstraction. That epic is **not filed yet — deliberately.** With XPRIZE, Artifact/Bedrock, and several other threads in flight, extracting a cross-cutting primitive now would be a shiny distraction competing with real deadlines. **This RFC is the tripwire:** the next time someone reaches for a bespoke gate, RFC-41 catches it, and *that* real need is what should make the migration earn priority — not our enthusiasm for the pattern. The migration is the falsification test; it runs when a live need pays for it.

The honest constraint is stated up front because it is the whole point of filing this now rather than coding it:

> **An abstraction is not proven by counting instances — it is proven when each instance converts onto the interface and either fits cleanly or breaks it.** Five bespoke instances confirm the *pattern*; they do not yet test the *abstraction*. Every one of them, including `supply.*` shipping this week, is hand-rolled — none has been built against `Predicate`.

The five instances (delegation, ad-eligibility, cultural DID, consent-tier, supply.*) were designed within one worldview. That is not five independent confirmations of an abstraction; it is one worldview expressed five times. The shape *feels* inevitable precisely because we made it feel that way — which is exactly the condition under which premature abstraction feels most justified and is most dangerous. The strangler migration (each instance converts at will; epic closes at five) is what turns confirmation into test.

So RFC-41 is a **falsifiable claim**, in the same discipline as conformance (prove against a runnable test) and RFC-39 (verify against the signed record), pointed this time at our own architectural instinct. An RFC that can only be confirmed and never falsified is a manifesto, not a spec. This one is designed to be broken by instance five.

**Receipt that deferral has been the right call repeatedly:** `ReactorConfig.condition` exists in `packages/bus/src/types.ts` (`condition?: string; // optional: future use for conditional execution`) and is evaluated **nowhere** (confirmed: absent from `config.ts` / `index.ts` evaluation paths). We designed the hook for gated composition and correctly did not build the evaluator. This RFC does not change that. It specifies what the evaluator *would* be, names the exit (strangler migration onto `Predicate`), and waits for a live need to pay for the focus.

---

## 1. Summary

Across the platform we keep building the same primitive:

> **A signed, scoped predicate — authored by the subject or collective it is about, evaluated at the edge, emitting only a boolean — that can consume other gates' booleans as inputs.**

Not *generalized* (one shape reused). **Composable** — gates take each other as inputs and chain like AND/OR/NOT logic gates in a circuit. Because each edge carries only a signed bit, arbitrary trust circuits can be assembled and the privacy invariant holds at every seam: a downstream gate consumes an upstream boolean **without seeing the inputs that produced it.**

The purest single statement is the **cultural gate** (RFC-07): `belongs-to(subject, context)`, signed by the collective, verifiable by anyone, no central roster. Every other instance is this gate at a different altitude.

---

## 2. The five instances (stable shape, unproven abstraction)

| Instance | Predicate | Author of the condition | Where evaluated | Status in code |
|----------|-----------|-------------------------|-----------------|----------------|
| **Cultural DID** (RFC-07) | `belongs-to(subject, culture)` | the collective | anyone, at the edge | Draft RFC |
| **Delegation / authority lineage** (RFC-40, RFC-32 §4.7) | `derives-authority-from(agent, principal)` within scope | the principal | resource / KYA-OS Verifier | resolver spec'd, delegation rows live (`identity_members`) |
| **Ad-eligibility / consent** (artifactagent #16, #5) | `consented-to-use(household, flight)` | the person (subject-authored) | eligibility store, per-flight | design note |
| **Consent-tier / broker** (bus broker: `consent.ts`, closed #1214/#1196) | `consent-exists(subject, requester, purpose)` | the subject | broker latch, fail-closed | **shipped** — closest to the real primitive today |
| **Supply custody** (Catalyst `supply.*`, #1375/#1384) | `custody-derives-from(lot, supplier-DID)` | the supplier | supply-recorder, per-movement | **shipping now** — Aug 17 XPRIZE clock, bespoke |

Two supporting mechanics that are *part of* the primitive, not separate:
- **Match-without-disclosure** (artifactagent #18) — the rule that a gate emits only a boolean, never its inputs. This is **what makes composition non-leaking.** Without it, chaining gates leaks.
- **Stub / claim** (the Trojan-horse mechanic) — a *pre-signed* membership mark that activates on claim. A cultural gate whose boolean is authored ahead of time and switched on by the subject's claim.

The broker (`consent.ts`) is the honest anchor: it is already `resolve → allow/reject`, **fail-closed**, composing overlapping grants as a union of fields. It is the primitive, built once, for one domain, not knowing it has four siblings.

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

## 5. How to falsify this — the exit IS the test (strangler migration)

The pattern is confirmed (5 instances). The abstraction is tested by **converting each instance onto `Predicate`**, one at a time, each on its own clock. A convergence epic (NOT filed yet — deferred by priority) would close only when all five run on the abstraction. Each conversion is a falsification test: it snaps on, or it fights the interface and *amends this RFC*.

The five conversions, in the order risk suggests (safest first, deadline-bound last):

1. **Broker / consent** (`packages/bus/reactors/consent.ts`) — already `resolve → boolean, fail-closed`; the reference conversion, lowest risk. The first real build unit when convergence earns priority: wire the dead `condition` field + ship `Predicate` against this one consumer.
2. **Cultural DID** (RFC-07) — the purest form; converts when it is built.
3. **Delegation / authority lineage** (RFC-40, `identity_members`).
4. **Ad-eligibility** (artifactagent #16/#5) — cross-repo; Artifact's clock.
5. **`supply.*`** (Catalyst) — **blocked-by the XPRIZE ship (Aug 17); converts *after*.** Never make a deadline demo the guinea pig for a new abstraction.

**Success is not "all five fit."** Success is that the spec is precise enough that each conversion *clearly* either fits or breaks — and if it breaks, we learn the abstraction's true width instead of pouring concrete on the rung we happen to be standing on. **Until a live need pays for the migration, this section is a plan, not a work order.**

> Candidate *future* instances that would also test the shape if they arrive first: RFC-37 corroboration escrow (a cross-subject gate — does `Predicate` hold when the condition is another gate firing on a *different* subject?), a Tripian journey-state gate, RFC-17 governance.

---

## 6. Non-goals

- **Not authorizing implementation.** No `evaluateGate`, no `Predicate` package, no `condition`-evaluator ships on the strength of this RFC. Build waits for a fifth need that tests the interface.
- Not deprecating the five bespoke gates. They work. Extraction happens (if ever) when a real consumer can't be served by the bespoke approach — or, more precisely, when a live need makes the strangler migration worth the focus (§5).
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
