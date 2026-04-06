# Work Order: Email & Notification Infrastructure

**Issues:** #538, #539, #540, #541, #542, #543
**Priority:** High — needed for marketing launch (April 1+)
**Dependency chain:** #538 → #539 → #540 → #541 (parallel: #542, #543)

---

## Context

The platform needs bulk email capability with a consent model. Registry is the consent authority. Notify is the delivery truck. Interests are inferred from activity and grow progressively with the user.

Current state:
- Notify exists with templates, per-DID preferences (email/inapp booleans), and single-send
- Registry exists with node/build/heartbeat/trust tables — no user preference tables
- `@imajin/email` sends via SendGrid — no unsubscribe headers
- `@imajin/notify` package has `send()` — no `broadcast()` or `interest()`
- `contact_email` on identities being backfilled from Stripe (#546)

---

## Agent 1: Registry — Interest Metadata + DID Consent Preferences (#538 + #539)

**Scope:** Schema + migrations + CRUD API on registry service

### Schema additions (apps/registry/src/db/schema.ts)

```typescript
// Interest metadata — declared by apps during registration
export const interests = registrySchema.table('interests', {
  id: text('id').primaryKey(),                           // int_<nanoid>
  scope: text('scope').notNull().unique(),               // 'events', 'market', 'coffee'
  label: text('label').notNull(),                        // 'Events & Gatherings'
  description: text('description'),                      // shown on preferences page
  triggers: jsonb('triggers').default([]),               // ['ticket.purchased', 'event.created']
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Global DID preferences
export const didPreferences = registrySchema.table('did_preferences', {
  did: text('did').primaryKey(),
  globalMarketing: boolean('global_marketing').default(true),
  autoSubscribe: boolean('auto_subscribe').default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Per-scope interests — created lazily from attestation activity
export const didInterests = registrySchema.table('did_interests', {
  id: text('id').primaryKey(),                           // din_<nanoid>
  did: text('did').notNull(),
  scope: text('scope').notNull(),                        // references interests.scope
  marketing: boolean('marketing').default(true),         // receive marketing for this scope?
  email: boolean('email').default(true),                 // email channel
  inapp: boolean('inapp').default(true),                 // in-app channel
  chat: boolean('chat').default(true),                   // chat DM channel
  createdByAttestation: text('created_by_attestation'),  // e.g. 'ticket.purchased'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  didIdx: index('idx_did_interests_did').on(table.did),
  scopeIdx: index('idx_did_interests_scope').on(table.scope),
  didScopeUnique: unique('uniq_did_interests_did_scope').on(table.did, table.scope),
}));
```

### API Routes (apps/registry/app/api/)

**Interest catalog:**
- `GET /api/interests` — list all registered interests
- `GET /api/interests/:scope` — get interest metadata + triggers for a scope

**DID preferences:**
- `GET /api/preferences/:did` — returns global prefs + all interest scopes with channel toggles
- `PUT /api/preferences/:did` — update global_marketing / auto_subscribe
- `PUT /api/preferences/:did/interests/:scope` — toggle per-scope marketing + channel booleans

**Audience query (internal):**
- `GET /api/audience/:scope` — returns DIDs where global_marketing=true AND scope.marketing=true
  - Optional `?channel=email` filter (also checks scope.email=true)
  - Auth: only kernel services (verify via webhook secret or service DID)

### Seed data — create interest records for existing apps:

```typescript
const SEED_INTERESTS = [
  { scope: 'events', label: 'Events & Gatherings', description: 'Updates about events you\'ve attended or shown interest in', triggers: ['ticket.purchased', 'event.created', 'event.rsvp'] },
  { scope: 'market', label: 'Marketplace', description: 'Updates about marketplace activity', triggers: ['listing.created', 'listing.purchased'] },
  { scope: 'coffee', label: 'Tips & Support', description: 'Updates about tips and support pages', triggers: ['tip.received', 'tip.sent'] },
  { scope: 'connections', label: 'Connections', description: 'Updates about your network', triggers: ['connection.accepted', 'pod.created'] },
  { scope: 'chat', label: 'Chat & Messaging', description: 'Chat notifications and mentions', triggers: ['chat.mention'] },
  { scope: 'learn', label: 'Learning', description: 'Course and learning updates', triggers: ['course.enrolled', 'module.completed'] },
];
```

### Migration
Use `scripts/migrate.sh` pattern. Create SQL migration file. **Do NOT use drizzle-kit push.**

### Auth on preference routes
- `GET/PUT /api/preferences/:did` — verify the requesting session DID matches `:did` (use existing auth middleware pattern from other services)
- `GET /api/audience/:scope` — verify `x-webhook-secret` header (same pattern as notify)

---

## Agent 2: Notify — Broadcast + Unsubscribe + Interest Signals (#540 + #541)

**Scope:** New endpoints on notify service + package updates

### @imajin/notify package additions (packages/notify/src/index.ts)

Add alongside existing `send()`:

```typescript
export async function broadcast(params: {
  scope: string;
  dids?: string[];         // optional — if omitted, resolve from registry audience
  subject: string;
  html: string;
  text?: string;
  channels?: ('email' | 'inapp' | 'chat')[];
}): Promise<void> { ... }

export async function interest(params: {
  did: string;
  attestationType: string; // e.g. 'ticket.purchased'
}): Promise<void> { ... }
```

### Notify service endpoints

**Broadcast (apps/notify/app/api/broadcast/route.ts):**
1. Verify caller authorization:
   - Check `x-webhook-secret` for kernel services
   - For app-scoped sends: validate caller app owns the scope (query registry)
   - `scope: 'system'` restricted to sysop DID only
2. If `dids` provided, use those. Otherwise `GET` registry `/api/audience/:scope`
3. For each DID: check registry preferences (global_marketing + scope.marketing + channel toggles)
4. Resolve DID → email via auth service (internal: `GET auth.imajin.ai/api/identity/:did` → contact_email)
5. Batch send via `@imajin/email` with rate limiting (max 100/batch, 1s delay between batches)
6. Include `List-Unsubscribe` and `List-Unsubscribe-Post` headers on every marketing email
7. Log sends to notifications table (scope, channelsSent, recipientDid)

**Interest signal (apps/notify/app/api/interest/route.ts):**
1. Receive `{ did, attestationType }`
2. Query registry interest catalog: which scope does this attestationType map to?
3. Check if `did_interests` row exists for DID + scope
4. If not: check `did_preferences.auto_subscribe`
   - true → create with all channels enabled
   - false → create with all channels disabled
5. Create via registry internal API: `POST /api/preferences/:did/interests/:scope`

**Unsubscribe (apps/notify/app/api/unsubscribe/route.ts):**
1. `GET /api/unsubscribe?did=X&scope=Y&token=Z` — renders "you've been unsubscribed" page
2. `POST /api/unsubscribe` — one-click List-Unsubscribe handler (RFC 8058)
3. Updates registry preference via internal API
4. Token is HMAC(did + scope + secret) — no DB lookup needed, just verify signature

### Email template updates

Add to `@imajin/email` or notify templates:
- `List-Unsubscribe` header: `<https://notify.imajin.ai/api/unsubscribe?did=X&scope=Y&token=Z>`
- `List-Unsubscribe-Post` header: `List-Unsubscribe=One-Click`
- Footer HTML in all marketing emails: "Don't want these emails? [Unsubscribe](link)"
- Physical address in footer (CAN-SPAM): use Imajin Inc. address

### Wire interest signals into existing attestation callers

Add `notify.interest()` calls alongside existing `notify.send()` calls in:
- `apps/events` — ticket purchase, event creation
- `apps/market` — listing created, listing purchased  
- `apps/coffee` — tip received
- `apps/connections` — connection accepted, pod created
- `apps/chat` — mention (already has notify, just add interest signal)

---

## Agent 3: WWW — Fix Double Opt-In + Preferences UI (#542 + #543)

**Scope:** imajin-web mailing list fix + notify preferences page update

### Fix double opt-in (imajin-web)

The TODO in `app/api/subscribe/route.ts`:
```typescript
// TODO: Send verification email via SendGrid (Step 9)
```

1. After `createVerificationToken()`, send verification email via SendGrid
2. Email contains link: `https://www.imajin.ai/api/verify-email?token=X&contactId=Y&listId=Z`
3. Create `app/api/verify-email/route.ts` — flips subscription status from `pending` to `subscribed`
4. Include List-Unsubscribe header in verification email
5. Verification email template: simple, clean, matches existing imajin email style

### Bridge logic

When a platform user creates an account with an email that matches an existing mailing list contact:
- Link the contact to their DID (add `did` column to contacts table if not present)
- On bulk sends: deduplicate by email across both populations

### Preferences UI update (apps/notify or wherever settings page lives)

**Find the existing notification preferences page and update:**

1. Read preferences from registry API (`GET /api/preferences/:did`) instead of local notify DB
2. Add global marketing toggle (master on/off)
3. Add auto-subscribe toggle
4. Show only earned interests (progressive — only scopes where `did_interests` rows exist)
5. Per interest row: scope label + description + marketing toggle + email/inapp/chat channel toggles
6. Empty state: "As you use the platform, your interests will appear here."
7. System alerts section (non-toggleable): "Security and system alerts are always delivered."
8. Writes go to registry API (`PUT /api/preferences/:did` and `PUT /api/preferences/:did/interests/:scope`)

---

## Migration Notes

- ALL migrations via `scripts/migrate.sh`. No `drizzle-kit push`.
- Registry needs new tables: `interests`, `did_preferences`, `did_interests`
- imajin-web may need `did` column on `contacts` table
- Check that `contact_email` column exists on `auth.identities` (being added by #546)

## Testing

- Seed interests for all existing apps on first deploy
- Backfill: script to replay existing attestations and create `did_interests` rows for ~130 users
- Dry run broadcast to verify audience query + email resolution works before sending real emails

## Environment Variables

New env vars needed:
- Registry: `NOTIFY_WEBHOOK_SECRET` (for audience endpoint auth)
- Notify: `REGISTRY_URL` (to query interest catalog + preferences + audience)
- Notify: `AUTH_SERVICE_URL` (to resolve DID → email)
- Notify: `UNSUBSCRIBE_HMAC_SECRET` (for one-click unsubscribe tokens)
