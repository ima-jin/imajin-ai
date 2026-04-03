# Frequently Asked Questions

---

### How does the chain work? Can it be manipulated?

Every identity on the network has a DFOS chain — a signed, append-only sequence of operations. Each entry is:

- **Signed** with the DID's Ed25519 private key. Only the key holder can author entries.
- **Hash-linked** to the previous entry. Change anything in the middle and every subsequent hash breaks.
- **Append-only.** There's no edit or delete operation in the protocol. Your chain is your permanent record.
- **Countersigned** when two parties interact. A transaction, attestation, or connection requires both parties to sign. Neither can fabricate an interaction the other didn't consent to.
- **Replayable by anyone.** Any third party can verify every signature, check every hash link, and independently compute your balance or reputation. The math either checks out or it doesn't.

To manipulate a chain you'd need to break Ed25519 (the same cryptography securing Solana, Signal, and SSH), convince every counterparty to re-sign fake entries, and replace the chain on every relay that synced it.

---

### What stops bad actors from spamming the network?

A few layers:

- **Gas costs.** Every action burns virtual MJN. You start with 100. Spam your chain and you run out. Want more? You need real transaction volume or actual platform participation.
- **Countersignatures.** The valuable entries — transactions, attestations, connections — require the other party to co-sign. You can sign whatever you want on your own chain, but nobody else's name is on it, which means it carries zero weight.
- **Trust graph.** Standing isn't just volume — it's diversity × age × attestation quality. A thousand self-signed entries from yesterday don't move the needle. A dozen countersigned interactions with established DIDs over six months do.
- **Economic floor.** Virtual MJN only converts to real MJN after $100 in verified settlements. Real money, through Stripe, with receipts. You can't fake that.

Two bad actors countersigning each other a thousand times is just a closed loop. The trust graph sees it for what it is — a cluster with no edges into the broader network.

---

### Can someone see my income or transactions?

No. Chains are not publicly readable by default.

Your chain proves things *to verifiers you choose*, not to the world. When an app checks your standing, it gets a proof — "this DID has preliminary trust, $100+ in verified settlements" — not a ledger. Think of it like showing your ID at a bar: they see "over 21," not your home address.

**What's visible:**
- Your DID (public key) — that you exist
- Attestations you explicitly make public (like a founding supporter badge)
- Whatever you choose to share with a specific service

**What's NOT visible:**
- Transaction amounts or counterparties
- Your full chain history
- Your balance
- Who you're connected to (unless they're also sharing)

This is the fundamental difference from blockchain. Bitcoin and Ethereum are global public ledgers — every transaction visible forever. DFOS chains are per-identity and access-controlled. The cryptography proves integrity without requiring transparency.

---

### What about privacy when tokens go onchain?

When MJN mints on Solana (Year 3), there are design choices that protect privacy:

1. **The mint is a one-time event, not a mirror.** The Solana wallet shows "X MJN minted" — not how you earned it. The granular history stays on your private DFOS chain.
2. **Wallet ≠ identity.** Your DID can derive a Solana wallet, but you can mint to a fresh wallet with no public link to your DID.
3. **MJNx (utility token) doesn't need to go onchain at all.** Daily commerce settles through Stripe. Only MJN (governance/equity) needs Solana.
4. **ZK bridges.** Privacy-preserving transfers are active research across the Solana ecosystem and will be more mature by Year 3.

The principle: DFOS chains are the private source of truth. Solana is the public settlement layer. You only expose what you choose to move onchain.

---

### Where are chains stored? What if the server dies?

Today, chains are stored on the relay at `registry.imajin.ai` (Postgres). Backups exist, but it's a single relay.

The end state is **federation**:

1. **Your chain lives on your node.** Run an Imajin node, your chain is local.
2. **Relays sync copies.** Multiple relays hold replicas via gossipsub — ours, community relays, your own backup.
3. **Any relay can verify any chain.** Integrity is in the math (signatures + hash links), not in who stores it.

"Server catches fire" goes from catastrophic to inconvenient — you resync from any relay that has your chain. The protocol already supports multi-relay sync. The deployment is catching up.

---

### How do early users benefit?

Every meaningful action on the platform creates a signed, timestamped entry on your DFOS chain. When MJN mints on Solana:

1. Read your DID's chain
2. Replay every credit and debit
3. Compute your balance
4. Mint that exact amount to your Solana wallet

There's no airdrop, no pre-mine, no spreadsheet. Someone who's been on the platform for two years has a chain dense with signed proof of work. That chain IS their allocation.

Founding supporters get an even better deal — contributions now earn virtual MJN at a founding rate, recorded as `supporter.founding` attestations on the chain. When tokens mint, the chain is the receipt.

It's the internet that pays you back.

---

### How do developers build on the network?

Import `@imajin/auth`. That gives you the full identity system, trust graph, and chain verification. Your app reads chains and verifies proofs — it never touches user data.

No revenue share. No data surrender. No kill switch. You build it, you run it, you keep it.

See the [Developer Guide](./DEVELOPER.md) to get started, or read the full protocol spec at [imajin.ai/llms-full.txt](https://imajin.ai/llms-full.txt).

---

### What's the difference between MJN and MJNx?

| | MJN | MJNx |
|--|-----|------|
| **Type** | Equity / governance | Utility / payment |
| **Backing** | Proof of participation (chain replay) | Fiat revenue (Stripe) |
| **Chain** | Solana (Year 3) | Database (off-chain) |
| **How you get it** | Earn through usage, founding attestation | Purchase or receive through commerce |
| **Convertible** | Tradeable post-mint | Withdraw to fiat anytime |
| **Purpose** | Governance, ownership, long-term alignment | Buying, selling, tipping, daily commerce |

MJN is earned, never purchased. MJNx is the money that flows through the marketplace. They solve different problems.

---

*Have a question not covered here? Find us on [DFOS](https://app.dfos.com/j/c3rff6e96e4ca9hncc43en) or [open an issue](https://github.com/ima-jin/imajin-ai/issues).*
