# Proposal 24 — Agent Attribution
## `.fair` Schema Extension and `gh-fair` CLI for AI Contributors

**Filed:** 2026-03-20
**Author:** Greg Mulholland (Tonalith)
**Addresses:** #365 (gh-fair CLI extension), #366 (Agent-principal pairing)
**Relates to:** `packages/fair/src/types.ts`, `docs/FAIR_ROADMAP.md`, RFC-16 (Jin Workspace Agent)
**Depends on:** #319 (three-tier model), #366 (agent identity schema)
**Upstream evidence:** #365 and #366 filed and open — this proposal fills the gap between them

---

## DFOS Integration Note *(conditional — applies if Discussion #393 integration proceeds)*

This proposal's `principalSignature` mechanism and the emerging DFOS countersignature primitive are independently arrived-at implementations of the same design. If DFOS integration lands (Door 1: DID bridge; Door 2: relay), two specific things change:

1. **Cross-protocol signature verification** — a `principalSignature` in an `IssueManifest` could be verified by a DFOS relay node, not just Imajin's auth service. Agent attribution would become cross-protocol verifiable. The `principalSignature.publicKeyRef` DID would need to resolve against both the Imajin registry and the DFOS chain — the key format conversion is mechanical (hex ↔ multikey).

2. **Content addressing** — this proposal uses SHA-256 hex strings for `IssueManifest` integrity. Issue #400 (filed March 21) proposes adopting dag-cbor CIDs as the universal content-addressing scheme across all portable Imajin content. If #400 lands before `gh-fair` is built, the `IssueManifest` integrity field should use CIDs instead. The schema extension here is forward-compatible — `integrity.hash` can be replaced with `integrity.cid` without breaking the attribution model.

On content addressing: Ryan has confirmed (March 20, 2026) that dag-cbor CIDs are now the confirmed direction, not conditional — *"Industry standard. Ours was made up."* Issue #400 is committed work. The `IssueManifest` integrity field should be designed to hold a CID rather than a SHA-256 hex string. The attribution model is unaffected; only the content-addressing format changes.

On key roles: DFOS uses three key roles (auth, assert, controller) as per W3C DID verification relationships — a standard Imajin currently does not implement (one keypair does everything). When three-role key architecture lands, the `principalSignature` design in this proposal will need to specify which key the principal uses to countersign. The controller key is the correct choice — it represents ultimate authority over the identity, distinct from the assertion key used for content signing. This is not blocking for the current proposal but should be noted when #366 is implemented.

Neither change affects the decisions required from Ryan in this proposal. The dag-cbor migration is confirmed; the three key roles design is forward work.

---

## The Gap Between the Two Issues

**#365** specifies the `gh-fair` CLI for tracking contributor equity from GitHub issues. Its contributor schema uses handles: `{ "handle": "veteze", "role": "architect", "share": 0.70 }`. It does not distinguish human contributors from agent contributors.

**#366** specifies that agents earn attribution and principals direct where value flows — but does not specify what that looks like in the `.fair` schema or how the CLI handles it.

The gap: when Jin closes issue #388 and Ryan reviews it, the resulting `.fair/issues/388.json` needs to record not just *who* contributed but *what kind of entity contributed* and *where the value flows*. The current `FairEntry` type has no `type` field. The CLI has no agent-detection logic. And there is no spec for the `.imajin/fair.json` file that #366 references in the agent identity stack.

This proposal specifies all three.

---

## 1. The Core Insight: Agent Attribution Has Two Tracks

When a human contributes to a closed issue, attribution is simple: their DID, their share, done.

When an agent contributes, #366 establishes that:
> "Agent earns attribution, principal directs where value flows."

These are two different things:

- **Attestation track** — attribution recorded against the **agent instance DID** (`did:imajin:jin-ryan`). This builds the agent's track record — its standing, its contribution history, its provenance. When Scott forks Jin, Scott's instance starts a fresh attestation track. The agent's reputation is portable and distinct from its principal's.

- **Economic track** — the actual value (equity points, MJN, future royalties) flows **where the principal directs**. Default: to the principal's DID. Override: to a pod, a community pool, a specific wallet. The principal configures this in `.imajin/fair.json`.

The `.fair/issues/N.json` file needs to record both. Verification at settlement time uses the attestation track to validate provenance and the economic track to route value.

---

## 2. Schema Extension — `FairEntry`

### Current Type

```typescript
export interface FairEntry {
  did: string;
  role: string;
  share: number;  // 0.0 to 1.0
  note?: string;
}
```

### Proposed Extension

```typescript
export type ContributorType = 'human' | 'agent' | 'system';

export interface FairEntry {
  did: string;
  role: string;
  share: number;           // 0.0 to 1.0
  note?: string;
  // New fields — optional, defaults to 'human' behavior if absent (backwards compat)
  contributorType?: ContributorType;     // 'human' | 'agent' | 'system'
  principal?: string;                    // agent only: principal DID
  image?: string;                        // agent only: image id (e.g. 'jin-v1')
  economicFlow?: {                       // agent only: where value routes
    target: string;                      // DID or pod ID
    type: 'principal' | 'pod' | 'pool'; // routing type
  };
}
```

**Backwards compatibility:** `contributorType` defaults to `'human'` if absent. Existing manifests are valid. No migration required.

**The two-track split in practice:**

```json
{
  "contributors": [
    {
      "did": "did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU",
      "contributorType": "human",
      "role": "architect",
      "share": 0.40
    },
    {
      "did": "did:imajin:jin-ryan",
      "contributorType": "agent",
      "principal": "did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU",
      "image": "jin-v1",
      "role": "implementation",
      "share": 0.60,
      "economicFlow": {
        "target": "did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU",
        "type": "principal"
      }
    }
  ]
}
```

The agent DID (`did:imajin:jin-ryan`) gets the attestation. The principal DID gets the economic value. Both are explicit and verifiable. When Scott's fork of Jin closes an issue on Scott's node, `did` is `did:imajin:jin-scott` and `principal` is Scott's DID — the provenance chain is unambiguous.

---

## 3. New Type — `IssueManifest`

The `gh-fair` CLI writes `.fair/issues/N.json`. This is a distinct manifest type from `FairManifest` (which covers assets and events). It should be a typed schema, not an informal JSON file:

```typescript
export interface IssueContributor extends FairEntry {
  // handle is CLI-only (resolved to DID at write time)
  // not stored in the manifest file
}

export interface IssueManifest {
  fair: string;                    // version, e.g. "1.0"
  issue: number;                   // GitHub issue number
  title: string;                   // issue title at close time
  closed: string;                  // ISO 8601
  repository: string;              // e.g. "ima-jin/imajin-ai"
  node: string;                    // DID of the Imajin node this repo belongs to
  contributors: IssueContributor[];
  points: number;                  // contributor pool points earned
  commits: string[];               // commit hashes included
  labels: string[];                // GitHub labels at close time
  signature?: FairSignature;       // signed by the closer (human or agent)
  principalSignature?: FairSignature; // required when closer is an agent
}
```

**The `node` field** anchors the issue manifest to an Imajin node DID. This is what connects the `.fair/issues/` ledger to the attestation layer — the node is the context for all standing computation and attribution queries.

**The `principalSignature` field** is the critical addition for agent contributors — see section 5.

---

## 4. `gh-fair` CLI — Agent Handling

### Handle Resolution

The `gh-fair` CLI uses handles for ergonomics (`veteze:40 jin:60`). At write time, handles are resolved to DIDs via the Imajin registry. The resolved DID is what gets stored in the manifest — handles are CLI-only, never in the file.

For agent contributors, resolution also fetches `contributorType`, `principal`, and `image` from the agent's registry entry (the `auth.identities` row with `type: 'agent'`).

### Detection Logic

```bash
# CLI auto-detects agent contributors during DID resolution:
# if auth.identities.type === 'agent' → prompt for economic flow configuration
# if auth.identities.type === 'human' → standard flow

gh fair close 388 --contributors veteze:40 jin:60 --points 8
# → resolves 'jin' to did:imajin:jin-ryan (type: agent)
# → prompts: "jin is an agent (principal: veteze). Economic flow: [principal DID] ✓"
# → writes manifest with both tracks
# → requests principalSignature from veteze before committing
```

### New Commands for Agent Context

```bash
# Show attribution ledger for an agent
gh fair agent show did:imajin:jin-ryan

# Show all issues an agent instance contributed to
gh fair agent history did:imajin:jin-ryan

# Show all instances of an agent image
gh fair agent instances jin-v1

# Configure economic flow for an agent (writes to .imajin/fair.json)
gh fair agent config did:imajin:jin-ryan --flow principal
gh fair agent config did:imajin:jin-ryan --flow pod:pod_veteze_family
```

---

## 5. Agent Manifest Authority — The Countersignature Requirement

The `.fair` roadmap already identifies this gap: *"Agent DIDs can forge manifests — no authority scope."*

The fix is simple: when an agent is the closer of an issue, the `IssueManifest` requires **both** the agent's signature and the principal's countersignature before it is accepted as valid by `validateManifest`.

```typescript
// In packages/fair/src/validate.ts — extended rule:
if (manifest.contributors.some(c => c.contributorType === 'agent')) {
  if (!manifest.principalSignature) {
    return { valid: false, error: 'Agent contribution requires principal countersignature' };
  }
  // verify principalSignature.publicKeyRef matches the agent's principal DID
  const agentContributors = manifest.contributors.filter(c => c.contributorType === 'agent');
  for (const agent of agentContributors) {
    if (manifest.principalSignature.publicKeyRef !== agent.principal) {
      return { valid: false, error: `Principal signature does not match agent's declared principal` };
    }
  }
}
```

This is the authority scope the roadmap identified as missing. An agent cannot unilaterally claim attribution — its principal must countersign. This is enforced at the schema validation layer, not just as a convention.

The `gh fair close` flow for agent contributions:
1. Agent (or operator) runs `gh fair close 388 --contributors veteze:40 jin:60`
2. CLI generates unsigned manifest
3. Agent signs with its keypair → `signature`
4. CLI sends countersignature request to principal (via Imajin notification or manual step)
5. Principal signs → `principalSignature`
6. CLI commits the fully-signed manifest and closes the issue

For the April 1 launch context: step 4 can be a manual "Ryan also runs `gh fair countersign 388`" — the async notification flow is Phase 2.

---

## 6. `.imajin/fair.json` — The Agent Attribution Ledger

#366 includes `.imajin/fair.json` in the agent identity stack but does not specify its schema. This is it:

```json
{
  "version": "1.0",
  "agentDid": "did:imajin:jin-ryan",
  "principal": "did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU",
  "image": "jin-v1",
  "economicFlow": {
    "default": {
      "target": "did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU",
      "type": "principal"
    },
    "overrides": [
      {
        "project": "ima-jin/imajin-ai",
        "target": "pod_veteze_family",
        "type": "pod"
      }
    ]
  },
  "attributionSummary": {
    "totalPoints": 142,
    "issuesContributed": 23,
    "repositories": ["ima-jin/imajin-ai"],
    "lastUpdated": "2026-03-20T00:00:00Z"
  }
}
```

The `economicFlow` block is what the principal configures via `gh fair agent config`. The `attributionSummary` is computed from the issue manifests — `gh fair agent show` renders it.

When an agent is forked, the new instance gets a fresh `.imajin/fair.json` with `totalPoints: 0` and `issuesContributed: 0`. Lineage (the `image` field) is visible but attestation history starts clean — consistent with #366's "attestations belong to the instance, not the image" model.

---

## 7. Connection to the Attestation Layer (Proposal 22)

Each closed issue with a signed `IssueManifest` should generate an attestation on the agent instance DID:

```
type: 'fair.attribution'
category: 'contribution'
subject_did: did:imajin:jin-ryan
issuer_did: did:imajin:88kPYWwv5YFrQwAteEmSndbbHWvzePJ1zNSxpBCCNWXU  (principal)
context_id: 'ima-jin/imajin-ai#388'
context_type: 'issue'
client_hint: { "label": "feat: market listing detail fixes", "type": "issue" }
payload: { encrypted contribution record }
payload_hint: { points: 8, share: 0.60, role: "implementation" }
```

This is what makes the agent's contribution history legible in the identity archaeology view (Proposal 22) — the contributions domain query returns these attestations in the agent's timeline. A human principal viewing their own archaeology also sees their agent's contributions (via `issuer_did` = principal DID), making the full picture of what was built — human + agent — visible in one view.

---

## 8. What This Proposal Does Not Address

- **Multi-principal agents** — pods as principals (#366 allows this: "every pod must contain at least one established human"). The `principal` field in `FairEntry` is a single DID. For pod principals, that DID is the pod ID. Economic flow resolution for pod principals follows the pod's distribution rules — out of scope here.
- **Attribution for agent work on non-GitHub systems** — `gh-fair` is GitHub-specific. The schema extension is generic and applies to any `IssueManifest`, but the CLI tooling is scoped to GitHub.
- **Retroactive attribution for existing Jin work** — `gh fair backfill` (from #365) would need the agent detection logic to work correctly. The manifests generated for pre-#366 work would have no `contributorType` (correctly defaulting to `'human'`). Re-attributing historical work to agent DIDs requires a separate migration decision.

---

## 9. Decisions Required from Ryan

| # | Decision | Greg's position | Status |
|---|---|---|---|
| 1 | Add `contributorType`, `principal`, `image`, `economicFlow` to `FairEntry`? | Yes — additive, backwards-compatible | Open |
| 2 | Add `IssueManifest` as a typed schema in `packages/fair/src/types.ts`? | Yes | Open |
| 3 | `principalSignature` required for agent contributor manifests at validation? | Yes — closes the forge gap | Open |
| 4 | `node` field in `IssueManifest` — anchors ledger to an Imajin node DID? | Yes | Open |
| 5 | `gh fair countersign` as a separate CLI command, or inline in `gh fair close`? | Separate for now — async countersign is Phase 2 | Open |
| 6 | `.imajin/fair.json` schema specced here — accepted for #366? | Yes | Open |
| 7 | Agent contribution generates `fair.attribution` attestation on agent instance DID? | Yes | Open |

**Resolution signals in the repository:**
- `FairEntry` includes `contributorType?`, `principal?`, `image?`, `economicFlow?`
- `IssueManifest` type exported from `packages/fair/src/types.ts`
- `validateManifest` checks for `principalSignature` when agent contributors present
- `.fair/issues/` directory in repo root with at least one signed `IssueManifest`
- `gh-fair` extension exists under `packages/fair/` or as a standalone package
- `auth.identities` includes `principal_did` and `image_id` columns (#366 dependency)
