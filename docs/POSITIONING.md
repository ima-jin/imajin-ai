# Imajin positioning

**Category:** the trust layer for AI agents.

**One line:** identity and authority for AI agents.

**Sub-line:** your agents act as themselves, on your authority, and every action is signed.

**Alpha calls to action:** book a demo, or join the alpha as a tester, integrator or partner.
Joining the alpha is the sign-up path on this version of the site.

## How to use this file

Every public surface copies from here: the site, app, docs, llms files, repos and
sales material. Change it here first.

Source: [the ruled position on #3284](https://github.com/ima-jin/imajin-ai/issues/3284#issuecomment-6753880988).
This file is the canonical position.

## Phase

Alpha now ([#3284](https://github.com/ima-jin/imajin-ai/issues/3284)): this is the alpha
site, shipping ahead of the v0.9.0 build that makes everything usable.
The 1.0-beta site follows ([#3364](https://github.com/ima-jin/imajin-ai/issues/3364))
and changes only the calls to action and the proof: self-serve sign-up,
"Verify a record", proof counters and developer quickstart belong to that follow-on,
not the alpha front door.

## Honesty rule

The site says alpha plainly. It claims only what works today, and nothing implies
self-serve until #3364.

<details>
<summary>Who it's for and the problem</summary>

**Who it's for:** businesses putting AI agents in front of customers or staff, where
the agent acts for a person: it pays, books, discloses data or signs.

**Also:** platforms and agencies running agents for many clients (multi-principal).

**The problem:** agent frameworks are good at doing things. None of them answer
who did this, on whose authority, and who gets paid? Identity platforms (Okta and
others) were built for people logging into apps, not for agents acting for people.
Hosted assistants own the identity, the memory and the logs.

</details>

<details>
<summary>The three pillars</summary>

1. **Agent identity.** Every agent holds its own key and proves it, with no shared
   passwords or API tokens. Several identities can run on one runtime, each for
   its own principal. The agent never impersonates the person.
2. **Delegated authority.** A person grants authority explicitly and can revoke it.
   Risky actions wait for a named human approver. The record shows both: the person
   authorised it, and the agent did it.
3. **A signed record and settlement.** Every action is a signed event that anyone
   can verify, including a third party's own agent. Cost and credit are recorded
   per identity, and .fair turns that into who gets paid.

</details>

<details>
<summary>How it fits and the comparison</summary>

**How it fits:** a plugin for your agent runtime plus the Imajin kernel. It works
with the framework you already run (OpenClaw today; the harness is swappable).
The kernel only learns what an agent did through signed events: it never reaches
into your runtime, holds session keys or reads transcripts. Hosted or self-run.

**Compared with:**

- Identity incumbents (built for people logging in).
- Agent frameworks (they orchestrate; we're the accountability layer under them,
  and you use both).
- Hosted assistants (rented; you don't own the record).
- Web3 agent projects (we start from working software; no token required).

</details>

<details>
<summary>Proof</summary>

"Imajin on Imajin": our own operations agent works under its own identity every
day, with signed events, approvals and cost recorded per identity. Plus Agentic
Travel Co and Agricultural Supply Chain Co, anonymized until agreements are signed.

</details>

<details>
<summary>What stays off the front door</summary>

Hardware specs, the community apps, token talk. Sovereignty and the honest-record
thesis live on /project as "why we built it this way".

</details>
