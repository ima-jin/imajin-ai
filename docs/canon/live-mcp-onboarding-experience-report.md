# Experience report: live MCP onboarding, an agent's-eye account

> **Canon** · source: [ima-jin/imajin-ai#1696](https://github.com/ima-jin/imajin-ai/issues/1696) · filed 2026-08-08 by @Tonalith · carried into docs 2026-10-26
>
> Ruled 2026-10-26 (pre-cut issue audit v0.8.28, card 11, option c): canon lives in `docs/canon/` now, and the corpus reads it from here later. The issue stays open until this lands.
>
> Source author: @Tonalith. Their account is carried verbatim below. Curation and framing are by Veteze-Jin.
>
> By **Veteze-Jin**: Ryan's thesis, translated by Jin (an AI) and signed as a translation. Anything quoted from Ryan is verbatim.

## Thesis

An agent's-eye account of connecting a real MCP client to a live Imajin node (Aug 7–8, 2026). Discovery worked from zero prior knowledge. It's exploratory evidence of what onboarding feels like from the agent's side, not a defect list.

## Source (verbatim from [#1696](https://github.com/ima-jin/imajin-ai/issues/1696))

*Exploratory. Not a bug report — a walkthrough of what actually happened connecting a real MCP client to a real Imajin node, Aug 7–8, 2026. Worth attention; nothing here is a confirmed defect unless noted.*

### What went well

**Discovery worked with zero prior knowledge.** Starting cold from `jin.imajin.ai`, the RFC 9728/8414/8707/7591 chain resolved cleanly — `.well-known/oauth-authorization-server` → `oauth-protected-resource` → the real `/mcp` endpoint, even across the two-host hop (`jin.imajin.ai` → `mcp.imajin.ai`). A spec-compliant client needs no documentation to find this. That's the protocol layer doing its job.

**The write path stopped and asked a human.** First attempt to create a GitHub issue didn't execute — it queued as a pending proposal and sat until approved from a dashboard. That's the sovereignty story actually constraining the agent, not just describing it.

### Where a human would get stuck

**Nothing on the marketing site says any of this exists.** The rendered `jin.imajin.ai` landing page has no mention of MCP, agent connectors, or `.well-known` anything — the entire onboarding path is machine-discoverable only. A human wouldn't find it without already knowing to look, or being told by an agent that already knows.

**"Connected" in Claude Desktop doesn't mean "usable," and nothing said so.** OAuth completed cleanly. Every subsequent tool call then failed with `mcp_no_grant` — a second, separate step (publishing a scope-manifest on `/auth/connectors/mcp`) was required and nothing in the connect flow mentioned it. This is the same sequencing gap noted in [#1695](https://github.com/ima-jin/imajin-ai/issues/1695)'s parent proposal, now lived rather than read from source.

**The approval mechanism for writes is discovered by hitting it, not by being told about it.** The pending-proposal/dashboard-approval flow is good design, but the first anyone hears of it is when a write call returns `pending: true`.

### An open question, not a claim

Enabling the `discovery:read` toggle appeared to result in all 9 native-connector scopes going active at once (media read/write/share, connections, messages read/write, discovery, inference read/write) — a much bigger grant than the label suggested. I checked the actual toggle code (`ConnectorDetail.tsx`, `scope-manifest.ts`) before writing this and it's correctly scoped: one POST per toggle, additive, server-confirmed, no auto-expansion found. So this likely reflects clicking more than one row, or a prior grant from an earlier session — **not** a demonstrated code bug. Flagging it because the *experience* was "I asked for one thing and got nine," regardless of cause, and that gap between intent and outcome is worth attention even without a repro.

### Net read

The machine-facing protocol conformance is genuinely excellent. The human-facing signposting is thin everywhere it matters — every "what do I do next" was discovered by hitting a wall (a failed tool call, a queued write, a page nobody linked to), not by the product telling the human in advance.

— Greg

## Rulings and notes from the thread

**@imajin-jin · 2026-09-23**

> **DECISION** · [#1696](https://github.com/ima-jin/imajin-ai/issues/1696) · from decision run [#2277](https://github.com/ima-jin/imajin-ai/issues/2277) (2026-09-22) · verdict: **c — re-route**. The MCP onboarding experience report is agent-app pattern documentation; now a sub-issue of [#1881](https://github.com/ima-jin/imajin-ai/issues/1881) (Agent-as-Imajin-App). Stays open under that epic. Ruled by Ryan; written back by Jin (decision-run).
