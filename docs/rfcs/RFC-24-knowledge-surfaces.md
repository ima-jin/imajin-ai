# RFC-24: Knowledge Surfaces — Learn, MCP, and the Queryable Profile

**Status:** Draft  
**Created:** 2026-04-03  
**Author:** Ryan Veteze  
**Discussion:** TBD

---

## Summary

Every Imajin profile is a queryable knowledge surface. Content accumulates from work (essays, code, attestations, conversations, media). An organizational skill — personal to each DID — structures it into a navigable, scoped surface. Learn is the readable output. MCP is the intake and query interface.

## Problem

Current knowledge tools (NotebookLM, Claude Projects, Notion) use flat folders. Hundreds of files, no structure, no scoping, no identity. Domain experts have deep knowledge scattered across tools and workflows. Turning that into something teachable requires sitting down and authoring — high friction, rarely done.

## Core Insight

The knowledge already exists. It's being created as a side effect of work. The missing piece is:
1. A way to ingest it from wherever it's created
2. A personal organizational model that sorts and structures it
3. A scoped, readable surface that others (human or agent) can query

## Architecture

### Five Components

| Component | Role |
|-----------|------|
| **MCP Server** | Intake funnel + query interface. Any tool can push content in, any authorized agent can query out. Thin wrapper over kernel APIs with delegation-scoped tool resolution. |
| **Organizational Skill** | Per-DID document structure preferences. How this person thinks — their taxonomy, categories, hierarchy. Learned from corrections over time. |
| **Learn** | The readable surface. Structured like a book — chapters, sections, embedded media. Auto-assembled from accumulated content, curated by the expert. |
| **Profile** | The access layer. Scoping controls who sees what: public, connection, collaborator, delegate. |
| **.fair** | Attribution and provenance. Every piece of content signed, content-addressed, linked to the DFOS chain. |

### Content Flow

```
Expert's workflow (any tool)
        │
        ▼
   MCP Server (intake)
        │
        ▼
   Media Service (storage + metadata)
        │
        ▼
   Organizational Skill (auto-sort + structure)
        │
        ▼
   Learn Surface (readable book)
        │
        ▼
   Profile (scoped access)
        │
        ▼
   Agent/Human queries via MCP or UI
```

### Intake Sources

Content enters via MCP calls from anywhere:
- **Writing tools** (Obsidian, VS Code, any editor) — push on save or commit
- **Git hooks** — docstrings, README changes, architectural decisions
- **DFOS chain events** — essays published, attestations made
- **Chat extraction** — conversations that crystallize insights
- **Direct upload** — media service UI

The expert never changes their workflow. MCP is the drain everything flows into.

### Organizational Skill

A per-DID configuration that defines:
- **Taxonomy** — how content is categorized (by domain, project, date, client, etc.)
- **Hierarchy** — chapter/section structure for the Learn surface
- **Defaults** — where new content lands when uncategorized
- **Scoping rules** — what's public by default, what requires explicit scoping

The skill is learned from the expert's corrections. Initial structure can be bootstrapped from existing content patterns. Over time, the system gets better at being you.

Example: Ryan's skill organizes around protocol layers, RFCs, and architectural decisions. A chef's skill organizes by technique, cuisine, and ingredient. A farmer's by crop, season, and parcel.

### Scoping Tiers

| Tier | Who | Sees |
|------|-----|------|
| **Public** | Anyone | Published essays, media, .fair manifests, attestation summary |
| **Connection** | Mutual connections | Shared project context, collaboration history, mutual attestations |
| **Collaborator** | Active project members | Repos, working documents, project chains |
| **Delegate** | Authorized agents | Everything the delegation VC permits |

### The Book Metaphor

Learn surfaces render as living books:
- Auto-assembled from accumulated work
- Expert curates — reorders, cuts, adds narrative
- Re-sorts as new content arrives
- Each chapter can have different scoping
- Embedded media (images, diagrams, code) inline
- .fair manifest signs the whole surface
- DFOS chain proves creation timestamps

### MCP Server Design

Thin. Almost trivially thin. The MCP server:
1. Receives connection with agent DID + delegation VC
2. Resolves scopes via delegation resolver
3. Exposes matching tools (read, search, list collections, ingest content)
4. Every call → kernel API → attestation on chain
5. Zero business logic in the MCP layer

Same kernel APIs the UI hits. Different presentation layer.

### Three Presentation Layers

| Layer | Consumer | Protocol |
|-------|----------|----------|
| **UI (HTML)** | Humans browsing | HTTP → shell → iframe → kernel API |
| **MCP** | Agents querying/ingesting | MCP → delegation resolver → kernel API |
| **CLI** | Developers/operators | Direct HTTP → kernel API |

Same kernel. Same auth. Same settlement. Same attestations.

## What This Makes Learn

Not a course platform. A tool for developing and refining your knowledge surface. The expert's workflow:

1. **Do your work** — write, build, publish, transact (content accumulates automatically)
2. **Curate** — review what's accumulated, adjust structure, set scoping (editing, not authoring)
3. **Teach** — your structured knowledge is now queryable by others

The person who wants to learn from you? Their agent hits your profile, gets scoped access to your Learn surface, and traverses your structured knowledge. Not modules and quizzes — a living book they can read, query, and reference.

## Relationship to Existing Systems

- **Media service** — already handles markdown and file storage; needs richer metadata (tags, scopes, collections)
- **Profile service** — already renders the public view; needs to expose scoped Learn surfaces
- **.fair** — already signs content; becomes the attribution layer for knowledge surfaces
- **DFOS chain** — already records attestations; proves provenance and creation timeline
- **Agent governance (work orders)** — delegation VCs and gas metering apply directly to MCP access

## Engagement Spectrum

Not everyone is a domain expert. The system serves all levels of participation:

| Level | Behavior | Surface |
|-------|----------|---------|
| **Passive** | Use the platform — buy tickets, chat, connect, transact | Activity trail (attestations, automatic) |
| **Light curation** | Save, bookmark, collect content from others | Collections (one tap, zero friction) |
| **Active curation** | Organize, scope, add narrative to accumulated content | Structured Learn surface (editing, not authoring) |
| **Full authoring** | Write essays, publish docs, push via MCP from external tools | Living book with chapters, media, .fair manifests |

Every user has a queryable profile from day one. The depth varies, but the system is the same.

### Saves and Collections

Casual users curate by saving — bookmarking a recipe, collecting event listings, saving a post. This is zero-friction signal about preferences and taste. What you save when nobody's watching is closer to who you are than what you post.

Saves are **references, not copies**. A saved recipe points to the original .fair manifest on the creator's Learn surface. The content is never duplicated — the attribution chain is structural.

The system infers preference categories from saves: this person collects music events, food content, and woodworking listings. That's a queryable preference profile built from behavior, without the user ever tagging or organizing anything.

### .fair in the Wild: The Dinner Party Example

A concrete user story for the full system working end-to-end:

1. **Chef** publishes a beef rigatoni recipe on their Learn surface → .fair manifest signed
2. **User** saves a reference to the recipe (one tap — not a copy, a reference to the signed original)
3. **User** makes it for a dinner party with friends
4. **Friends** loved it, remember the dinner, don't remember the chef
5. Weeks later, a **friend** queries the user's profile: "what was that rigatoni?"
6. **Reference** resolves back to the chef's Learn surface → .fair attribution intact
7. **Chef** sees: 14 people saved this recipe, referenced in 6 conversations

What happened:
- The recipe traveled through **social trust**, not algorithmic distribution
- The friends never needed to know about .fair or attribution — they just wanted the recipe
- The chef got credit **structurally**, not by policy. The save IS the attribution because it points to the .fair manifest
- No screenshots, no reposts, no content copying. The reference is the content.

This is what kills the platform incentive to strip attribution. You can't save it without the credit because the save points to the signed original. The protocol handles attribution invisibly. Normal people just save recipes and ask friends about dinner parties.

## Open Questions

1. How granular is scoping? Per-chapter? Per-section? Per-artifact?
2. Does the organizational skill live on-chain or in the workspace?
3. How does versioning work — is the book a snapshot or always-live?
4. What's the minimum viable Learn surface for first users?
5. How does search work across multiple profiles' public surfaces?

## Implementation Path

1. **Media metadata enrichment** — tags, scopes, collections on media assets
2. **Organizational skill format** — define the per-DID configuration schema
3. **Learn rendering** — book-like view of structured content from media
4. **MCP server** — thin kernel API wrapper with delegation resolver
5. **Intake integrations** — git hooks, editor plugins, chain event triggers

---

*"Every domain expert has a book in them. This tool pulls it out of their work instead of asking them to write it from scratch."*
