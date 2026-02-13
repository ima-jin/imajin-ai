# imajin-ai

**A sovereign transactional layer for your agent, bot, or device.**

Identity. Payments. Attribution. No platform lock-in.  
Every interaction signed, typed, and owned by you.

---

## The Thesis

The platforms extract. Netflix, Uber, Stripe, Auth0 — they sit between you and value, taking a cut of everything. Your identity lives on their servers. Your transactions flow through their pipes. Your agent runs on their cloud.

**What if the substrate was yours?**

- Your keys, your identity
- Your transactions, your rules  
- Your device, your presence
- Humans and agents using the same primitives

imajin-ai is the infrastructure layer. Open source. Self-hostable. No subscriptions.

---

## The Stack

| Layer | Project | Purpose |
|-------|---------|---------|
| **Identity** | [auth](./apps/auth) | Sovereign identity for humans + agents |
| **Payments** | pay *(planned)* | Pluggable transactions (Stripe, Solana, etc.) |
| **Attribution** | [.fair](https://github.com/ima-jin/fair) | Who made what, who gets paid |
| **Presence** | [Unit](https://github.com/ima-jin/imajin-os) | Hardware anchor — physical device you own |
| **Orchestration** | [imajin-cli](https://github.com/ima-jin/imajin-cli) | How agents do things |

---

## Apps

Tools built on the sovereign stack:

| App | Domain | Purpose | Status |
|-----|--------|---------|--------|
| [auth](./apps/auth) | auth.imajin.ai | Identity service | 🟢 Scaffold |
| [dykil](./apps/dykil) | dykil.imajin.ai | Community spending tracker | 🟢 Scaffold |
| [karaoke](./apps/karaoke) | karaoke.imajin.ai | Event queue manager | 🟢 Working |
| learn | learn.imajin.ai | AI training courses | 🟡 Planning |
| pay | pay.imajin.ai | Payment service | 🟡 Planning |
| profile | profile.imajin.ai | Identity profiles | 🟡 Planning |
| shop | shop.imajin.ai | Local marketplace | 🟡 Planning |
| coffee | coffee.imajin.ai | Local cafe/commerce | 🟡 Planning |
| tickets | tickets.imajin.ai | Events/ticketing | 🟡 Planning |
| connect | connect.imajin.ai | Communication layer | 🟡 Planning |

---

## Packages

Shared infrastructure:

| Package | Purpose |
|---------|---------|
| [@imajin/auth](./packages/auth) | Identity types, signing, verification |
| [@imajin/ui](./packages/ui) | Shared UI components |
| [@imajin/db](./packages/db) | Database utilities |
| [@imajin/config](./packages/config) | Shared configs |

---

## How It Works

### Identity

Every human and agent gets a keypair. No passwords. No OAuth.

```
1. Generate Ed25519 keypair
2. Register public key → get DID (did:imajin:xxx)
3. Sign challenges to authenticate
4. Every message you send is signed and typed (human/agent)
```

Apps validate through auth.imajin.ai or verify signatures directly.

### Signed Messages

Every interaction in the system:

```typescript
{
  from: "did:imajin:abc123",  // who
  type: "agent",              // human or agent (always labeled)
  timestamp: 1707850800000,
  payload: { ... },           // the actual content
  signature: "..."            // proves you control the key
}
```

No impersonation. No confusion about who you're talking to.

---

## Philosophy

> "Don't you know I'm local?"

A riff on "don't you know I'm loco?" — same defiant energy, but for community economics. Money should circulate locally, not flow to Silicon Valley.

**DYKIL** tracks where community money leaks to platforms.  
**The sovereign stack** is how you plug the leak.

---

## Setup

```bash
# Install dependencies
pnpm install

# Run specific app
pnpm --filter @imajin/dykil dev
pnpm --filter @imajin/auth-service dev

# Push database schema
pnpm --filter @imajin/auth-service db:push
```

---

## Structure

```
imajin-ai/
├── apps/
│   ├── auth/          # Identity service (auth.imajin.ai)
│   ├── dykil/         # Community economics (dykil.imajin.ai)
│   ├── karaoke/       # Event queue (karaoke.imajin.ai)
│   └── ...
├── packages/
│   ├── auth/          # @imajin/auth - identity primitives
│   ├── ui/            # Shared components
│   ├── db/            # Database client
│   └── config/        # Shared configs
└── turbo.json
```

---

## Related Projects

- **[imajin-os](https://github.com/ima-jin/imajin-os)** — The Unit hardware + firmware
- **[imajin-cli](https://github.com/ima-jin/imajin-cli)** — Agent orchestration
- **[.fair](https://github.com/ima-jin/fair)** — Attribution standard

---

## License

MIT — because sovereignty means you can fork it.

---

*Built by [Imajin](https://imajin.ai) — 今人 — "now-person"*
