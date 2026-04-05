# C10 — Relay Authorization Gap

**Flagged:** March 23, 2026
**Source:** Issue #454 (filed March 23, 2026)
**Priority:** HIGH — pre-production blocker
**Related:** P27 §8 (relay as core node infrastructure), PR #453 (relay live), DFOS protocol 0.2.0

---

## The Concern

The DFOS web relay is now live in registry (`/relay/[[...path]]`, PR #453). The relay correctly implements the protocol spec and uses a `PostgresRelayStore` backed by drizzle. **However, relay writes are currently unauthenticated — any client can commit operations to chains hosted on the relay.**

From issue #454:
> *"Currently the relay endpoint is open — any client can write. Before we open the relay to external nodes or go to prod, writes must be authenticated. Otherwise anyone can commit to chains hosted on our registry."*

## Why This Matters

P27 §8 established that every Imajin node running a relay is simultaneously:
- Verifying identity chains for its own users
- Propagating proof availability across the federation
- Enabling offline verification for any participant who has synced the relevant chains

An unauthenticated relay write endpoint means an attacker can commit arbitrary operations to chains hosted on the registry, potentially corrupting identity chain state for any DID that has its chain stored there. This is a trust boundary that the chain model depends on: chain integrity guarantees require that only the DID holder (or authorized delegates) can append to their chain.

The relay is currently marked dev-only (`dev-registry.imajin.ai`) so this is not an immediate production risk. But it must be resolved before:
- External nodes are invited to participate in the relay network
- The relay is promoted to the production registry (`registry.imajin.ai`)
- #433 (virtual MJN gas credits) writes ledger entries via chain operations

## What Resolution Requires

Per #454 and DFOS protocol 0.2.0 spec:

1. **Gate relay writes to require a verified Imajin DID** — signed JWT from `@imajin/auth` middleware
2. **Reads remain open** (or optionally gated for dark-forest content later)
3. **Decision: external DFOS DIDs?** — should non-Imajin DFOS identities be allowed to write? Likely yes with their own JWT, but tracked separately from Imajin DIDs. This is the inbound federation question from P26 §"Reverse Flow."

DFOS protocol 0.2.0 adds signed JWT auth tokens and VCs for delegating chain commits and relay authZ. The relay package already implements this — it's a configuration/wiring task, not a protocol design task.

## Architectural Implication

This concern also surfaces the first explicit question about relay governance: should the relay serve as a public commons (any valid DFOS DID can write) or as a scoped infrastructure (only Imajin DIDs, or Imajin DIDs + explicitly federated nodes)? P27 §7.3 (trust discount for external DFOS users) implies the latter — a chain is valid but trust is local. The relay should probably mirror this: writes allowed for any verifiable DID, but reads from non-Imajin DIDs are marked as external scope.

## Resolution Signal

- Relay write routes require JWT in `Authorization` header
- `@imajin/auth` middleware applied to relay write paths
- External DFOS DID writes tracked with distinct scope flag
- Dev relay promoted to prod after auth gate confirmed working

---

**Status:** Open — #454 filed March 23, pre-production requirement
