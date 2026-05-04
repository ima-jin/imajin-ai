# Adapters

An adapter maps an external platform into Imajin's tool surface. It's how your agent talks to Shopify, Stripe, Salesforce, or any other service — without ever touching API keys.

---

## What an Adapter Is

An adapter is a typed tool surface with:

- **Credential isolation** — the agent calls `shopify.listOrders()`, the gateway injects the API key. The agent never sees credentials.
- **Schema validation** — inputs and outputs are typed with Valibot. Bad data is caught before it leaves the kernel.
- **.fair attribution** — when an adapter generates value (a sale, a booking, a lead), the adapter's .fair manifest determines how revenue flows to the adapter's creator.
- **Grant enforcement** — the kernel checks that the agent is authorized to use this adapter's tools before execution.

Think of adapters as the community-contributed surface area of Imajin. The kernel provides the core tools (identity, chat, media, commerce). Adapters extend the tool surface to the entire ecosystem of external services.

## How Adapters Work

```
Agent Runtime          Imajin Kernel          Adapter          External Service
     │                      │                    │                    │
     │── tool.call ────────>│                    │                    │
     │   shopify.listOrders │── validate ───────>│                    │
     │                      │   grant + scope    │                    │
     │                      │                    │── HTTP + creds ──>│
     │                      │                    │<── response ──────│
     │                      │                    │                    │
     │                      │<── typed result ───│                    │
     │                      │   + gas consumed   │                    │
     │<── tool.result ──────│                    │                    │
     │   typed, validated   │                    │                    │
```

The agent sees `shopify.listOrders`. The adapter handles the Shopify API, authentication, pagination, error handling. The kernel handles grant checking, gas metering, and chain recording. Nobody trusts the agent with credentials.

## Anatomy of an Adapter

```typescript
import { defineAdapter, defineTool } from '@imajin/agent-env';
import * as v from 'valibot';

export default defineAdapter({
  name: 'shopify',
  version: '1.0.0',
  description: 'Shopify store management',
  
  // Credentials the adapter needs — injected by kernel, never exposed to agent
  credentials: {
    apiKey: { type: 'string', description: 'Shopify API key' },
    storeDomain: { type: 'string', description: 'mystore.myshopify.com' },
  },
  
  // .fair manifest — adapter creator earns when the adapter generates value
  fair: {
    contributors: [
      { id: 'did:imajin:adapter-creator-did', role: 'developer', weight: 1.0 }
    ]
  },
  
  tools: [
    defineTool({
      name: 'shopify.listOrders',
      description: 'List recent orders from the Shopify store',
      grantRequired: 'operator',
      gasCost: 5,
      params: v.object({
        status: v.optional(v.picklist(['open', 'closed', 'cancelled'])),
        limit: v.optional(v.number()),
      }),
      result: v.array(v.object({
        id: v.string(),
        email: v.string(),
        totalPrice: v.string(),
        createdAt: v.string(),
      })),
      execute: async (params, credentials) => {
        const res = await fetch(
          `https://${credentials.storeDomain}/admin/api/2024-01/orders.json?status=${params.status || 'any'}&limit=${params.limit || 10}`,
          { headers: { 'X-Shopify-Access-Token': credentials.apiKey } }
        );
        const data = await res.json();
        return data.orders.map(o => ({
          id: o.id.toString(),
          email: o.email,
          totalPrice: o.total_price,
          createdAt: o.created_at,
        }));
      }
    }),
    
    defineTool({
      name: 'shopify.createProduct',
      description: 'Create a new product in the Shopify store',
      grantRequired: 'operator',
      gasCost: 10,
      params: v.object({
        title: v.string(),
        bodyHtml: v.optional(v.string()),
        vendor: v.optional(v.string()),
        price: v.string(),
      }),
      result: v.object({
        id: v.string(),
        title: v.string(),
        handle: v.string(),
      }),
      execute: async (params, credentials) => {
        const res = await fetch(
          `https://${credentials.storeDomain}/admin/api/2024-01/products.json`,
          {
            method: 'POST',
            headers: {
              'X-Shopify-Access-Token': credentials.apiKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              product: {
                title: params.title,
                body_html: params.bodyHtml,
                vendor: params.vendor,
                variants: [{ price: params.price }],
              }
            }),
          }
        );
        const data = await res.json();
        return {
          id: data.product.id.toString(),
          title: data.product.title,
          handle: data.product.handle,
        };
      }
    }),
  ],
});
```

## How to Build an Adapter

### 1. Define the Tool Surface

Think about what operations the external service offers, and what an agent would actually need:

- **Read operations** (list, get, search) → `Observer` or `Operator` grant
- **Write operations** (create, update) → `Operator` grant  
- **Financial operations** (charge, refund, transfer) → `Transactor` grant

Keep tools focused. `shopify.listOrders` is better than `shopify.query` with a giant params object.

### 2. Type Everything

Params and results use Valibot schemas. This gives:
- Compile-time type safety for TypeScript runtimes
- Runtime validation on both sides (kernel validates params, agent validates results)
- Auto-generated documentation

### 3. Isolate Credentials

The adapter declares what credentials it needs. The user configures them through the Imajin admin UI. The kernel injects them at execution time. The agent never sees them.

This is critical. An agent with `shopify.listOrders` access can list orders. It cannot extract the Shopify API key and use it for something else.

### 4. Set .fair Attribution

When your adapter generates value (a sale through Shopify, a booking through a travel API), the .fair manifest determines how adapter-attributed revenue flows. The adapter creator earns a share — this is the incentive to build and maintain quality adapters.

### 5. Publish

Adapters publish to the Imajin adapter registry. Node operators choose which adapters to enable. Users configure credentials per adapter.

```bash
# Package and publish
npm run build
imajin adapter publish
```

## Existing Adapters

As adapters ship, they'll be listed here. The first adapters in development:

| Adapter | Service | Status |
|---------|---------|--------|
| `imajin-chat` | Imajin chat (OpenClaw plugin) | Live |
| `imajin-identity` | Imajin identity operations | Live |

## The Contribution Model

Adapter creators earn through .fair when their adapter generates value. This isn't a marketplace with listing fees — it's attribution. If your Shopify adapter processes a $100 sale and the scope fee is 0.25%, the .fair manifest on your adapter determines your cut of that 0.25%.

Build useful adapters. Earn when they're used. No gatekeeping.

---

*Next: [Integration Guides →](./integration-guides.md)*
