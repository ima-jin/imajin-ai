# .fair v1.1 UI Audit

## Current State of `AssetDetail.tsx`

`apps/kernel/src/components/media/AssetDetail.tsx` currently handles `.fair` manifest display/editing as follows:

- **Display (sidebar):** Uses `<FairEditor>` from `@imajin/fair` in `readOnly={true}` mode, showing `attribution`, `access`, `transfer` sections.
- **Edit (modal):** Clicking "Edit ✏️" opens `FairEditModal`, which wraps `<FairEditor>` in `readOnly={false}` mode inside a fixed overlay modal. Save POSTs to `/media/api/assets/{id}/fair`.
- **No v1.1 awareness:** The editor only shows v1.0 primitives (attribution, access, transfer, integrity). It does not display or edit v1.1 fields like `training`, `commercial`, `distribution`, or `tipping`.
- **No signing flow:** The fair PUT endpoint does not sign manifests. The client sends the manifest as JSON and it's stored directly.

## `FairAccordion` vs `FairManifestEditor`

- **`FairAccordion`** (exists in `@imajin/fair`) is a **read-only** display component for attribution splits, fees, and distributions. It is used in consumer-facing contexts (e.g., event tickets). It is NOT an editor.
- **`FairEditor`** (exists in `@imajin/fair`) is the current editable component, but it only handles v1.0 fields and its UI is a single flat panel.
- **Decision:** For the v1.1 UI in `AssetDetail`, we need a NEW editor component — `FairManifestEditor` — that:
  - Consumes a v1.1 manifest and emits changes
  - Has collapsible accordion-style sections for each v1.1 primitive
  - Lives in `apps/kernel/src/components/media/` (app-specific, not shared)
  - Uses shared primitives (`DidShareListEditor`, `MoneyInput`) from `@imajin/ui`
  - `FairAccordion` remains as the read-only consumer component; we do NOT modify it.

## `<DidShareListEditor>` API Decisions

- **Location:** `packages/ui/src/DidShareListEditor.tsx` (shared component library)
- **Props:**
  ```ts
  interface DidShareListEditorProps {
    value: DidShareList;
    onChange: (value: DidShareList) => void;
    readOnly?: boolean;
    className?: string;
    defaultDid?: string; // pre-fill for new rows
  }
  ```
- **Behavior:**
  - Array editor for `{ did?, role, share, name?, note? }`
  - Live sum display; error state (red text) when sum ≠ 1.0
  - Slider (0–100, 0.5 step) + number input for share
  - Deletable rows, "+ Add" button
  - Validates against D1 rules (share 0–1, sum = 1.0)
  - Does NOT include `fixed` Money input by default — that is added by the consumer (`FairManifestEditor`) when a row has `fixed` set

## `<MoneyInput>` API Decisions

- **Location:** `packages/ui/src/MoneyInput.tsx`
- **Props:**
  ```ts
  interface MoneyInputProps {
    value?: Money;
    onChange: (value: Money | undefined) => void;
    readOnly?: boolean;
    className?: string;
    currencies?: string[]; // default: ['USD', 'EUR', 'GBP', 'CAD', 'MJNX']
  }
  ```
- **Behavior:**
  - Amount field: stores cents internally, displays as decimal (e.g., 100 → "1.00")
  - Currency selector: ISO 4217 short list + MJNX
  - Shows formatted preview (e.g., "$1.00 USD")
  - Forward ref, className passthrough

## "Upgrade to v1.1" Endpoint Location + Auth Pattern

- **Location:** `apps/kernel/app/media/api/assets/[id]/upgrade-fair/route.ts`
- **Auth:** `requireAuth(request)` → owner DID must equal `asset.ownerDid`
- **Signing limitation:** The server does not have access to user private keys. The existing "owner-signed action" pattern in this codebase is:
  1. Client signs with browser-stored keypair (for chat messages, attestations via auth service)
  2. Server verifies the session but does not sign on behalf of users
- **Decision for the upgrade endpoint:**
  - Server upgrades the manifest structure using `upgradeToV1_1()`
  - Server does NOT cryptographically sign with the owner's key (impossible server-side)
  - Instead, the server signs with the **node's platform key** (`AUTH_PRIVATE_KEY`) and sets `signature.signer` to the **node DID** (`getNodeDid()`). This is a **platform attestation** pattern, consistent with `emitSessionAttestation`.
  - The client can re-sign with the owner's key on the next save via the existing PUT `/fair` flow.
  - Documented as transitional — true owner signing may be added when the auth service supports delegated signing.
- **Bus event:** Publish `asset.fair.upgraded` with `{ assetId, oldVersion, newVersion, signer }`. Register in `packages/bus/src/config.ts` with attestation reactor.

## Open Questions

1. Should the upgrade endpoint also publish `fair.manifest.published` for DFOS? — **Deferred to #897/#882**. We'll add a conditional check: if `publishContentEvent` is available, call it; otherwise skip.
2. Should `DidShareListEditor` live in `@imajin/fair` instead of `@imajin/ui`? — **No.** It's a generic array editor primitive that could be reused outside .fair contexts (e.g., revenue splits in other apps). `@imajin/ui` is the right home.
