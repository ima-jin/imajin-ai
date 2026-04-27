---
title: Application Conformance Suite
type: rfc
status: draft
author: Ryan Veteze
slug: RFC-20-application-conformance-suite
topics:
  - federation
refs:
  rfcs:
    - 19
---
# RFC-20: Application Conformance Suite

**Status:** Draft
**Author:** Ryan Veteze
**Date:** 2026-03-29

---

## Summary

Define a conformance testing framework for how applications interpret DFOS chain state. Protocol conformance (Brandon's relay suite) validates storage and replication. Application conformance validates interpretation — how DAG forks project into application state.

## Problem

DFOS 0.6.0 introduced forkable DAG chains. The protocol deliberately leaves fork semantics to the application layer: "the DAG is fully walkable at the application layer, and how a DAG is projected into application state is application semantics" (Brandon, March 29 2026).

This creates a conformance gap. Two apps can both talk to a conformant relay and interpret the same chain data differently. A member list app that reads only the canonical head will silently drop concurrent additions. An attestation viewer that ignores non-head branches will miss valid attestations. The relay is correct. The application is broken. Nothing catches it.

## Solution

A three-layer conformance model:

### Layer 1: Protocol Conformance (exists)

Brandon's relay conformance suite. Validates that relays correctly store, replicate, and serve DAG chains. Currently 89 tests at 0.6.0.

Imajin does not own this layer. DFOS does.

### Layer 2: Chain-Type Conformance (this RFC)

For each chain type that Imajin defines, a test suite validates the application-layer projector — the function that reads a DAG and produces application state.

A **chain type** is a named interpretation contract: "given this DAG shape, the projected state MUST look like this."

### Layer 3: Userspace App Conformance (future)

Full application compliance including UI behavior, settlement integration, .fair handling. Out of scope for this RFC — covered by the kernel/userspace compliance suite in RFC-19.

## Chain Types and Projector Semantics

### Type: Identity (single-writer, canonical head)

The identity chain is owned by one keypair. Concurrent forks represent the same actor on multiple devices. Only the deterministic head matters.

**Projector rule:** State = replay operations along the path from genesis to canonical head. Ignore non-head branches.

**Conformance tests:**
- Single linear chain → state matches final operation
- Fork with two tips → state matches the tip selected by deterministic head (latest `createdAt`, CID tiebreaker)
- Fork where one branch deletes, other updates with later timestamp → identity is NOT deleted (undeletion via fork)
- Key rotation on one branch, display name update on other → state reflects whichever branch is canonical head

### Type: Membership Set (CRDT, set union)

Member lists for communities, events, groups. Multiple admins can add/remove members concurrently. All valid additions from all branches must be reflected.

**Projector rule:** State = union of all add operations across all branches, minus any remove operations that causally follow the corresponding add.

**Conformance tests:**
- Two concurrent adds from different forks → both members present in projected state
- Add on one fork, independent add on other → both present
- Add on one fork, remove of same member on other fork (no causal relationship) → conflict resolution rule: [TBD — add-wins or remove-wins, needs decision]
- Add then remove on same branch → member removed
- Concurrent adds of the same member → idempotent, member present once

### Type: Attestation Log (append-only, all branches valid)

Attestation chains record trust-relevant events. Every attestation in every branch is valid. Forks represent concurrency, not conflict.

**Projector rule:** State = full set of all operations across all branches. Ordering by `createdAt`. No deduplication needed (each attestation has a unique CID).

**Conformance tests:**
- Linear chain with 3 attestations → all 3 in projected state
- Fork with 2 attestations on each branch → all 4 in projected state
- Attestation on non-head branch → still included in projected state
- Duplicate CID across branches (replication artifact) → deduplicated to one

### Type: Message Stream (append-only, ordered)

Chat messages and event logs. Every message from every branch is valid content. Forks represent concurrent senders.

**Projector rule:** State = all operations across all branches, ordered by `createdAt`. Ties broken by CID (lexicographic).

**Conformance tests:**
- Linear chain → messages in order
- Fork with interleaved timestamps → messages merge-sorted by `createdAt`
- Same `createdAt` on two forks → CID tiebreaker determines order
- Message on non-head branch → included in stream

### Type: Configuration (single-writer, last-write-wins)

Settings, preferences, feature flags. Sequential by nature. Only the canonical head matters.

**Projector rule:** Same as Identity — state = canonical head.

**Conformance tests:**
- Same as identity chain tests, applied to config payloads

## Test Suite Architecture

```
@imajin/chain-conformance"
├── projectors/
│   ├── identity.test.ts
│   ├── membership.test.ts
│   ├── attestation.test.ts
│   ├── message-stream.test.ts
│   └── configuration.test.ts
├── fixtures/
│   ├── linear-chain.json
│   ├── simple-fork.json
│   ├── multi-tip-dag.json
│   ├── delete-fork.json
│   └── concurrent-writers.json
└── runner.ts
```

Each test provides a DAG fixture (a set of signed operations with known structure) and asserts on the projected state. The projector under test is provided by the application — the test suite is a validator, not an implementation.

### Running Conformance

```bash
# Test a projector implementation
npx @imajin/chain-conformance --type membership --projector ./my-membership-projector.ts

# Test all chain types
npx @imajin/chain-conformance --all --projector-dir ./projectors/
```

## Userspace Integration

Any userspace app registered in the Imajin registry that handles a specific chain type MUST pass the corresponding conformance tests. This is part of the RFC-19 compliance suite.

The registry records which chain types an app claims to handle. The compliance suite runs the corresponding projector tests. Failure = non-conformant = not listed.

## Scope

The five chain types defined above are a starting point, not an exhaustive list. New chain types will emerge as userspace apps invent new ways to read DAG state. The framework — DAG fixture in, projected state assertion out — is what matters. The current tests are the first five rows in a table that grows with the ecosystem.

Third-party app developers can define their own chain types with custom projector semantics and register conformance tests alongside them. The pattern is extensible by design.

## Open Questions

1. **Membership add/remove conflict resolution:** When concurrent forks contain an add and a remove for the same member with no causal relationship, does add win or remove win? Add-wins is more conservative (never silently drop members). Remove-wins respects admin intent. Needs decision.

2. **Custom chain types:** Can userspace apps define their own chain types with custom projector semantics? If so, how do they register conformance tests? Possible: chain type manifests that include test fixtures.

3. **Projector versioning:** When projector rules change, how do existing chains migrate? The DAG is immutable — only the interpretation changes. Versioned projectors with explicit migration rules.

4. **Cross-chain references:** An attestation might reference a membership chain. Does the attestation projector need to resolve cross-chain state? Probably not at this layer — cross-chain semantics are application logic above the projector.

## References

- RFC-19: Kernel/Userspace Architecture
- DFOS 0.6.0 conformance suite (89 tests)
- Brandon (Clearbyte): "how a DAG is projected into application state is application semantics"
- Ben Feist (NASA): CRDT architecture for multi-writer document merging
- Automerge, Yjs: Prior art on CRDT-based collaboration

---

*"The protocol defines conformance for storage. The application defines conformance for interpretation."*
