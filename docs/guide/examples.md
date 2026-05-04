# Examples

Real-world agent patterns built on Imajin. Each example shows the agent logic and how Imajin's primitives (identity, attestation, settlement, audit) make it work.

---

## Travel Agent with Credential Verification

A travel agent that books hotels and verifies traveler credentials — the SHITSUJI pattern.

### The Scenario

A family is traveling to Hawaii. The travel agent needs to:
1. Verify the lead traveler's identity
2. Check passport/visa credentials without storing them
3. Book accommodations through a partner API
4. Settle payment with attribution to all parties (agent operator, travel platform, hotel)

### How It Works with Imajin

```typescript
async function handleBookingRequest(env: ImajinAgentEnv, request: BookingRequest) {
  // 1. Verify the traveler's identity tier
  const traveler = await env.callTool('identity.resolve', {
    did: request.travelerDid
  });
  
  if (traveler.data.tier === 'soft') {
    await env.callTool('chat.send', {
      conversation: request.conversationDid,
      content: 'To book travel, we need verified identity. Would you like to start verification?'
    });
    return;
  }
  
  // 2. Request credential via consent-gated release
  //    The traveler sees exactly what's being requested and approves/denies
  const credential = await env.callTool('identity.requestCredential', {
    subject: request.travelerDid,
    type: 'travel.passport',
    purpose: 'Hotel booking verification — Hilton Hawaiian Village',
    retention: 'none'  // Don't store after verification
  });
  
  if (!credential.ok) {
    // Traveler denied the request — agent can't proceed
    await env.callTool('chat.send', {
      conversation: request.conversationDid,
      content: 'No worries — booking requires passport verification. Let me know if you change your mind.'
    });
    return;
  }
  
  // 3. Book through the hotel adapter (credentials injected by kernel)
  const booking = await env.callTool('hilton.createReservation', {
    property: 'hawaiian-village',
    checkIn: request.checkIn,
    checkOut: request.checkOut,
    guests: request.guestCount,
    verificationToken: credential.data.token  // One-time token, not raw data
  });
  
  // 4. Create checkout with .fair attribution
  const checkout = await env.callTool('commerce.checkout', {
    amount: booking.data.totalPrice,
    currency: 'USD',
    fair: {
      contributors: [
        { id: env.principal, role: 'operator', weight: 0.02 },  // Agent operator
        { id: 'did:imajin:tripian', role: 'platform', weight: 0.03 },  // Travel platform
        { id: 'did:imajin:hilton-hwv', role: 'vendor', weight: 0.95 }  // Hotel
      ]
    }
  });
  
  await env.callTool('chat.send', {
    conversation: request.conversationDid,
    content: `Booking confirmed! Complete payment here: ${checkout.data.url}`
  });
  
  // Everything above is on the chain:
  // - Identity verification request + consent
  // - Credential check (without storing PII)
  // - Booking creation
  // - Payment with .fair attribution
  // All signed, all auditable, all replayable.
}
```

### What Imajin Provides Here

- **Consent-gated credential release** — the traveler approves exactly what data is shared, with whom, and for how long
- **One-time verification tokens** — the agent proves the credential is valid without holding the raw data
- **Multi-party .fair settlement** — operator, platform, and vendor all get attributed correctly
- **Audit trail** — if something goes wrong, replay the chain. Every step is signed.

---

## Commerce Agent with .fair Settlement

An agent that manages a marketplace storefront — listing products, processing orders, settling payments with attribution.

```typescript
async function processOrder(env: ImajinAgentEnv, order: Order) {
  // Fetch the .fair manifest for this product
  const product = await env.callTool('media.read', {
    asset: order.productId
  });
  
  // The .fair manifest was set by the human seller — the agent can't modify it
  // It might look like:
  // {
  //   contributors: [
  //     { id: "did:imajin:artisan", role: "creator", weight: 0.80 },
  //     { id: "did:imajin:photographer", role: "photographer", weight: 0.10 },
  //     { id: "did:imajin:marketplace", role: "platform", weight: 0.10 }
  //   ]
  // }
  
  // Create checkout — settlement follows the .fair manifest automatically
  const checkout = await env.callTool('commerce.checkout', {
    amount: order.amount,
    currency: 'CAD',
    productId: order.productId,
    // No .fair override — uses the product's manifest
  });
  
  // Notify the buyer
  await env.callTool('chat.send', {
    conversation: order.buyerConversation,
    content: `Order ready! Pay here: ${checkout.data.url}\n\nThis purchase supports: ${product.data.fair.contributors.map(c => c.role).join(', ')}`
  });
  
  // When payment settles (async, via event):
  env.on('commerce.settled', async (settlement) => {
    if (settlement.orderId === order.id) {
      // Settlement has already split revenue per .fair manifest
      // Creator got 80%, photographer got 10%, platform got 10%
      // After protocol fees (MJN 1%, node 0.5%, buyer credit 0.25%, scope 0.25%)
      
      await env.callTool('chat.send', {
        conversation: order.buyerConversation,
        content: 'Payment confirmed! Your order is being prepared.'
      });
    }
  });
}
```

### What Imajin Provides Here

- **.fair enforcement** — the agent processes orders but can't alter revenue splits. The human seller set the attribution. The protocol enforces it.
- **Transparent attribution** — the buyer sees who they're supporting
- **Automatic settlement** — the kernel handles the math, the Stripe split, and the chain recording

---

## Support Agent with Attestation Trail

An agent that handles customer support — with every resolution attested and auditable.

```typescript
async function handleSupportTicket(env: ImajinAgentEnv, ticket: SupportTicket) {
  // Read the customer's attestation history with this business
  const history = await env.callTool('identity.attestations', {
    subject: ticket.customerDid,
    issuer: env.principal,
    types: ['customer', 'transaction.settled', 'support.resolved']
  });
  
  // Long-time customer with clean history? Different approach than first-timer.
  const isEstablished = history.data.length > 10;
  
  // Agent reasoning happens in your runtime — this is just the tool interaction
  const resolution = await determineResolution(ticket, history.data, isEstablished);
  
  if (resolution.type === 'refund') {
    // Refunds above threshold need human consent
    const result = await env.callTool('commerce.refund', {
      transactionId: ticket.transactionId,
      amount: resolution.amount,
      reason: resolution.reason
    });
    
    // If this was above the consent threshold, the principal was asked to approve
    // The chain records: agent requested refund → human approved → refund processed
  }
  
  // Record the resolution as an attestation
  await env.callTool('identity.attest', {
    type: 'support.resolved',
    subject: ticket.customerDid,
    payload: {
      ticketId: ticket.id,
      resolution: resolution.type,
      satisfaction: ticket.customerRating
    }
  });
  
  // The attestation is now part of both the agent's chain AND the customer's history
  // Next time this customer has an issue, the support agent sees the full trail
}
```

### What Imajin Provides Here

- **Attestation-based history** — the agent's decisions are informed by real, verifiable history, not a CRM database that anyone can edit
- **Consent gate on high-value actions** — refunds above a threshold require human approval
- **Bidirectional attestations** — both the agent and the customer have the resolution on their chains

---

## Insurance Agent with Audit-Ready Chain

An agent that processes insurance claims — where regulatory compliance requires a complete audit trail.

```typescript
async function processClaim(env: ImajinAgentEnv, claim: InsuranceClaim) {
  // Step 1: Verify claimant identity
  const identity = await env.callTool('identity.resolve', {
    did: claim.claimantDid
  });
  
  // Step 2: Request relevant credentials (consent-gated)
  const medicalAuth = await env.callTool('identity.requestCredential', {
    subject: claim.claimantDid,
    type: 'medical.authorization',
    purpose: `Insurance claim ${claim.id} — medical records access`,
    retention: '90days',  // Regulatory minimum
    basis: 'contractual'  // Legal basis for processing
  });
  
  // Step 3: Assess claim (agent reasoning in your runtime)
  const assessment = await assessClaim(claim, medicalAuth.data);
  
  // Step 4: Record assessment as attestation
  await env.callTool('identity.attest', {
    type: 'insurance.assessed',
    subject: claim.claimantDid,
    payload: {
      claimId: claim.id,
      assessmentResult: assessment.decision,
      factors: assessment.factors,
      modelVersion: assessment.modelVersion  // Which model made this decision
    }
  });
  
  // Step 5: If approved, settle (always requires human consent for insurance)
  if (assessment.decision === 'approved') {
    await env.callTool('commerce.settle', {
      amount: assessment.approvedAmount,
      recipient: claim.claimantDid,
      fair: {
        contributors: [
          { id: env.principal, role: 'insurer', weight: 1.0 }
        ]
      },
      reference: `claim:${claim.id}`
    });
  }
  
  // The complete chain for this claim:
  // 1. Identity verification
  // 2. Credential request + consent
  // 3. Assessment with model version
  // 4. Human approval (via consent gate)
  // 5. Settlement
  //
  // A regulator can replay this chain end-to-end.
  // Every step is signed by the agent DID, traceable to the human principal.
  // The model version is recorded — if the model changes, you can see which
  // version made which decisions.
}
```

### What Imajin Provides Here

- **Regulatory-grade audit trail** — every step signed, timestamped, non-repudiable
- **Model version recording** — critical for AI governance. Which model version made which decision?
- **Consent with legal basis** — not just "user clicked OK" but structured consent with purpose, retention period, and legal basis
- **Chain replay** — give the chain to a regulator and they can verify every step independently

---

## What These Examples Share

Every example above follows the same pattern:

1. **Identity** — resolve DIDs, verify tiers, check attestation history
2. **Consent** — request credentials through the consent gate, not by scraping
3. **Action** — call tools through the kernel (signed, scoped, gas-metered)
4. **Attribution** — .fair manifests determine revenue flow
5. **Record** — every step on the chain, replayable and auditable

The agent runtime handles reasoning. Imajin handles everything else.

---

*Back to: [What is Imajin](./what-is-imajin.md) · [The Interface](./the-interface.md) · [Developer Guide](../developer-guide.md)*
