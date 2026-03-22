# Work Order: #435 — Migrate chat v1 → v2 and remove v1 tables

## Context

Chat has two parallel conversation systems:
- **v1**: `chat.conversations` + `chat.participants` + `chat.messages` + `chat.message_reactions` + `chat.conversation_reads` + `chat.read_receipts` (conv_xxx IDs)
- **v2**: `chat.conversations_v2` + `chat.messages_v2` + `chat.message_reactions_v2` + `chat.conversation_reads_v2` (DID-keyed)

Event lobby already posts to v2. The chat list page queries both. This causes split conversations, duplicates, and two codepaths.

**Goal:** v2 becomes the only system. v1 tables and routes are removed.

## Branch

Create branch `feat/chat-v2-migration` off `main`.

## Step 1: Data migration script

Create `apps/chat/scripts/migrate-v1-to-v2.ts` — a runnable script that:

1. Reads all v1 `conversations` rows
2. For each:
   - `type='direct'`: look up the two participant DIDs from `participants`, derive `did:imajin:dm:{hash}` using the same logic as `conversation-did.ts` (`dmDid(did1, did2)`)
   - `type='group'`: derive `did:imajin:group:{hash}` from sorted member DIDs using `groupDid(members)`
   - If an event lobby (has `context.type === 'event'`), use the event DID directly (look up from events DB or use existing convention)
3. Upserts into `conversations_v2` (don't overwrite if already exists — some v2 rows exist)
4. Copies all `messages` → `messages_v2`, mapping `conversation_id` → the derived `conversation_did`
5. Copies `message_reactions` → `message_reactions_v2`
6. Copies `conversation_reads` → `conversation_reads_v2`
7. Prints a summary of what was migrated

Use `@imajin/db` getClient() for raw SQL. The script should be idempotent (safe to run twice). Use `--dry-run` flag.

**Import the actual `dmDid` and `groupDid` functions** from `src/lib/conversation-did.ts` to ensure hash consistency.

## Step 2: Update `/start` route to use v2

File: `apps/chat/src/app/start/route.ts`

Currently creates v1 conversations for DMs. Change to:
1. Derive `did:imajin:dm:{hash}` using `dmDid(myDid, targetDid)`
2. Check if `conversations_v2` row exists for that DID
3. If not, create it
4. Redirect to `/conversations/${encodeURIComponent(dmDid)}`

Remove all v1 imports (`conversations`, `participants`).

## Step 3: Update `/api/conversations` route to query v2

File: `apps/chat/src/app/api/conversations/route.ts`

**GET:** Rewrite to query `conversations_v2` + `messages_v2` instead of v1 tables. Use the same discovery logic as `/api/conversations-v2/route.ts` (read records, sent messages, created convs, pod membership). Return the same response shape the UI expects. Resolve other participant info for DMs by parsing the DID type.

**POST:** 
- For `type='direct'`: derive `dmDid()`, upsert into `conversations_v2`, redirect to it
- For `type='group'`: derive `groupDid()`, create in `conversations_v2`
- Remove all v1 table inserts

## Step 4: Update `/api/conversations/unread` to query v2

File: `apps/chat/src/app/api/conversations/unread/route.ts`

Replace `conversationReads` + `messages` + `participants` with `conversationReadsV2` + `messagesV2`. Discovery uses same approach as conversations-v2 route (reads + sent messages + created + pod membership).

## Step 5: Rewrite v1 sub-routes to v2

These routes under `/api/conversations/[id]/` currently use v1 `conv_xxx` IDs. Since after migration all conversations are DID-keyed, the `[id]` param will be a DID (URL-encoded).

### `/api/conversations/[id]/messages/route.ts`
- **GET:** Query `messagesV2` where `conversationDid = id`. Verify access via auth service.
- **POST:** Insert into `messagesV2`. Auto-create `conversations_v2` if needed (same as `/api/d/[did]/messages`).

### `/api/conversations/[id]/messages/[msgId]/route.ts`
- Update/delete on `messagesV2`

### `/api/conversations/[id]/read/route.ts`
- Upsert into `conversationReadsV2`

### `/api/conversations/[id]/upload/route.ts`
- Update `participants` check to use access control (auth service) instead of v1 participants table

### `/api/conversations/[id]/participants/route.ts`
- Rewrite to use `/api/d/[did]/members` logic or auth access checks

### `/api/conversations/[id]/route.ts`
- GET conversation details from `conversationsV2`

### `/api/messages/[msgId]/reactions/route.ts`
- Use `messageReactionsV2` instead of `messageReactions`

### `/api/invites/route.ts` and `/api/invites/[id]/route.ts`
- These reference `conversations` and `participants`. Update to reference `conversationsV2`. Invites table itself (`chat.invites`) is v1-only — keep the invites table for now (it references `conversations.id`). Actually: update the invite to reference the conversation DID instead. Or: if invites aren't actively used, leave a TODO.

## Step 6: Update conversations list page (UI)

File: `apps/chat/src/app/conversations/page.tsx`

- Remove dual-fetch (currently fetches `/api/conversations` AND `/api/conversations-v2`)
- Fetch only `/api/conversations` (which now returns v2 data)
- Remove `V1Conversation` interface
- Remove v1→display mapping
- The response from GET /api/conversations should include: did, name, type, lastMessageAt, lastMessagePreview, unread, and for DMs: otherParticipant info

## Step 7: Update conversation detail page

File: `apps/chat/src/app/conversations/[id]/page.tsx`

- Remove `LegacyConversationView` entirely (~700 lines)
- The page always uses `DIDConversationView` (all IDs are now DIDs)
- Keep the `parseConvDid` inline helper
- The URL param is always a URL-encoded DID

## Step 8: Remove `/api/conversations-v2` route

File: `apps/chat/src/app/api/conversations-v2/route.ts`

Delete this file. Its functionality is now in `/api/conversations`.

## Step 9: Remove `/api/participants/migrate` route

File: `apps/chat/src/app/api/participants/migrate/route.ts`

Delete — no longer needed.

## Step 10: Update schema

File: `apps/chat/src/db/schema.ts`

Remove v1 tables: `conversations`, `participants`, `messages`, `conversationReads`, `readReceipts`, `messageReactions`. Keep: `invites`, `publicKeys`, `preKeys` (these are independent).

File: `apps/chat/src/db/schema-v2.ts`

Rename the tables to drop the "v2" suffix in the Drizzle schema names (the actual Postgres table names stay as-is for now — renaming tables can be a follow-up):
- `conversationsV2` → keep export name but consider clarity

Actually, **don't rename exports yet**. That's a massive search-replace across all files. Just remove v1 tables from schema.ts and keep v2 as-is. We can rename in a follow-up.

File: `apps/chat/src/db/index.ts`

Keep as-is (imports both schema files).

## Step 11: Drizzle migration

Generate a drizzle migration that drops v1 tables:
- `chat.conversations`
- `chat.participants`  
- `chat.messages`
- `chat.conversation_reads`
- `chat.read_receipts`
- `chat.message_reactions`

**Do NOT drop** `chat.invites`, `chat.public_keys`, `chat.pre_keys` — those are still used.

Update `invites` table to reference `conversations_v2.did` instead of `conversations.id` — or remove the FK constraint and keep the column as a plain text field pointing to a conversation DID.

## Step 12: Clean up

- Remove `src/app/api/participants/[did]/conversations/route.ts` (uses v1 `participants` table)
- Update `NewChatModal` if it creates v1 conversations
- Verify `@imajin/chat` package doesn't reference v1 routes
- Check `useWebSocket.ts` for v1 references

## Files to modify (summary)

**Delete:**
- `src/app/api/conversations-v2/route.ts`
- `src/app/api/participants/migrate/route.ts`
- `src/app/api/participants/[did]/conversations/route.ts` (if only v1)

**Create:**
- `scripts/migrate-v1-to-v2.ts`
- Drizzle migration (via `drizzle-kit generate`)

**Major rewrites:**
- `src/app/api/conversations/route.ts` — v1→v2
- `src/app/api/conversations/unread/route.ts` — v1→v2
- `src/app/api/conversations/[id]/messages/route.ts` — v1→v2
- `src/app/api/conversations/[id]/messages/[msgId]/route.ts` — v1→v2
- `src/app/api/conversations/[id]/read/route.ts` — v1→v2
- `src/app/api/conversations/[id]/upload/route.ts` — v1→v2
- `src/app/api/conversations/[id]/participants/route.ts` — v1→v2
- `src/app/api/conversations/[id]/route.ts` — v1→v2
- `src/app/api/messages/[msgId]/reactions/route.ts` — v1→v2
- `src/app/api/invites/route.ts` — update refs
- `src/app/api/invites/[id]/route.ts` — update refs
- `src/app/start/route.ts` — v1→v2
- `src/app/conversations/page.tsx` — remove dual-fetch
- `src/app/conversations/[id]/page.tsx` — remove LegacyConversationView
- `src/db/schema.ts` — remove v1 tables (keep invites, publicKeys, preKeys)

## Testing

After all changes:
1. `npx next build` from `apps/chat/` must succeed
2. The migration script should handle: 0 v1 rows (no-op), existing v2 rows (skip), multiple conversation types
3. Chat list page renders v2-only conversations
4. Event lobby chat still works (already on v2)
5. DM creation via `/start?did=xxx` works
6. New group creation works

## Important notes

- **DO NOT** touch `packages/chat/` — it's a shared UI package, not routes
- **DO NOT** rename v2 table exports (that's a follow-up)
- The `invites` table FK to `conversations.id` needs updating — either drop the FK or change the column to reference `conversations_v2.did`
- Access control for v2 conversations goes through `auth.imajin.ai /api/access/:did` — this is how v2 routes already work
- The v2 route at `/api/d/[did]/messages` is the reference implementation — match its patterns for the rewritten v1 routes

When completely finished, run this command to notify me:
openclaw system event --text "Done: #435 chat v1→v2 migration complete" --mode now
