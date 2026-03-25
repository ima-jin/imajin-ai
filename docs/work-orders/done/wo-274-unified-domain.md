# Work Order: Unified Domain + Slug Prefixes

**Issues:** #274, #232
**Priority:** High — blocks registration flow for April 1
**Estimated effort:** 1-2 days

---

## Goal

Compose all 15 services under `jin.imajin.ai` with path-based routing. One domain, one cookie, no CORS. Add slug prefixes for public routes to prevent collisions.

## Prerequisites

- [ ] Caddy access on server (`/etc/caddy/Caddyfile`)
- [ ] DNS: `jin.imajin.ai` → server IP (Dreamhost or Cloudflare)

## Phase 1: Slug Prefixes (#232)

Add short prefixes for public-facing dynamic routes. Do this FIRST since it's needed regardless of domain change.

### Events

```
/e/[slug]  →  public event page (currently /[eventId])
/[eventId]  →  301 redirect to /e/[eventId]
```

**Files:**
- `apps/events/app/e/[eventId]/page.tsx` — new route (move from `app/[eventId]/page.tsx`)
- `apps/events/app/[eventId]/page.tsx` — redirect to `/e/[eventId]`
- Update all internal `<Link>` and `router.push()` calls to use `/e/` prefix
- Update ticket email templates (`src/lib/email.ts`)
- Update checkout success redirect (`app/checkout/success/page.tsx`)

### Profile

```
/p/[handle]  →  public profile (currently /[handle])
/[handle]  →  301 redirect to /p/[handle]
```

**Files:**
- `apps/profile/app/p/[handle]/page.tsx` — new route
- `apps/profile/app/[handle]/page.tsx` — redirect

### Coffee

```
/c/[slug]  →  coffee profile (currently /[slug])
```

### Links

```
/l/[slug]  →  link page (currently /[slug])
```

### Learn

Already uses `/course/[slug]` — no change needed.

## Phase 2: basePath Configuration (#274)

Set `basePath` in each service's `next.config.js`. This tells Next.js all routes, assets, and API calls are prefixed.

```js
// Example: apps/events/next.config.js
module.exports = {
  basePath: '/events',
  // ... existing config
}
```

### Full basePath Map

| Service | basePath | Port (prod) |
|---------|----------|-------------|
| www | `/` (none) | 7000 |
| auth | `/auth` | 7001 |
| registry | `/registry` | 7002 |
| connections | `/connections` | 7003 |
| pay | `/pay` | 7004 |
| profile | `/profile` | 7005 |
| events | `/events` | 7006 |
| chat | `/chat` | 7007 |
| input | `/input` | 7008 |
| media | `/media` | 7009 |
| coffee | `/coffee` | 7100 |
| dykil | `/dykil` | 7101 |
| links | `/links` | 7102 |
| learn | `/learn` | 7103 |
| market | `/market` | 7104 |

### What basePath Does Automatically

- `<Link href="/create">` → renders as `/events/create`
- `fetch('/api/webhook')` → becomes `/events/api/webhook`
- Static assets (`/_next/...`) → `/events/_next/...`
- `next/image` src paths adjusted automatically

### What basePath Does NOT Handle (manual updates needed)

- **Service-to-service URLs in `.env.local`** — update all `*_SERVICE_URL` vars
  - Before: `AUTH_SERVICE_URL=https://auth.imajin.ai`
  - After: `AUTH_SERVICE_URL=https://jin.imajin.ai/auth`
- **Hardcoded fetch URLs in client components** — grep for full subdomain URLs
- **Email templates** — ticket links, magic links
- **External integrations** — Stripe webhook URLs, OAuth callback URLs

### Grep Checklist

```bash
# Find all hardcoded service URLs that need updating
grep -rn "auth\.imajin\|events\.imajin\|pay\.imajin\|profile\.imajin\|chat\.imajin\|registry\.imajin\|connections\.imajin\|media\.imajin\|input\.imajin\|coffee\.imajin\|dykil\.imajin\|links\.imajin\|learn\.imajin\|market\.imajin" apps/ --include="*.tsx" --include="*.ts" -l | grep -v node_modules | grep -v .next
```

## Phase 3: Caddy Config

```caddyfile
jin.imajin.ai {
    # Public slug routes (short prefixes — MUST come before service paths)
    handle /e/* {
        reverse_proxy localhost:7006
    }
    handle /p/* {
        reverse_proxy localhost:7005
    }
    handle /c/* {
        reverse_proxy localhost:7100
    }
    handle /l/* {
        reverse_proxy localhost:7102
    }

    # Service paths
    handle /auth/* {
        reverse_proxy localhost:7001
    }
    handle /events/* {
        reverse_proxy localhost:7006
    }
    handle /pay/* {
        reverse_proxy localhost:7004
    }
    handle /profile/* {
        reverse_proxy localhost:7005
    }
    handle /registry/* {
        reverse_proxy localhost:7002
    }
    handle /connections/* {
        reverse_proxy localhost:7003
    }
    handle /chat/* {
        reverse_proxy localhost:7007
    }
    handle /input/* {
        reverse_proxy localhost:7008
    }
    handle /media/* {
        reverse_proxy localhost:7009
    }
    handle /coffee/* {
        reverse_proxy localhost:7100
    }
    handle /dykil/* {
        reverse_proxy localhost:7101
    }
    handle /links/* {
        reverse_proxy localhost:7102
    }
    handle /learn/* {
        reverse_proxy localhost:7103
    }
    handle /market/* {
        reverse_proxy localhost:7104
    }

    # Default: www
    reverse_proxy localhost:7000
}
```

## Phase 4: Subdomain Redirects

Keep old subdomains alive as 301 redirects. **Exception:** `registry.imajin.ai` stays permanent (referenced in DFOS spec).

```caddyfile
# Keep registry alive permanently (DFOS spec reference)
registry.imajin.ai {
    reverse_proxy localhost:7002
}

# Redirect all others
events.imajin.ai {
    redir https://jin.imajin.ai/events{uri} 301
}
auth.imajin.ai {
    redir https://jin.imajin.ai/auth{uri} 301
}
# ... repeat for all 13 remaining subdomains
```

## Phase 5: Cookie & Session Updates

- Cookie domain stays `.imajin.ai` — already works for `jin.imajin.ai`
- Verify `SameSite=None` is still needed (may be able to switch to `Lax` since same origin now)
- Check `packages/config/src/session.ts` for any domain-specific logic

## Verification

```bash
# After deploy, verify each path
curl -I https://jin.imajin.ai/auth/api/session
curl -I https://jin.imajin.ai/events/api/events
curl -I https://jin.imajin.ai/e/summer-camp-15
curl -I https://jin.imajin.ai/p/veteze

# Verify redirects
curl -I https://events.imajin.ai/admin/evt_3bacf8e14a586ba0d2e8f21e
# Should return 301 → jin.imajin.ai/events/admin/evt_3bacf8e14a586ba0d2e8f21e

# Verify registry stays live
curl -I https://registry.imajin.ai/relay/.well-known/dfos-relay
```

## Rollback

If anything breaks:
1. Revert Caddy config to subdomain routing
2. Remove `basePath` from next.config.js files
3. Rebuild affected services
4. Subdomains resume immediately
