# Retire Input Service

The `apps/input` service (ports 3008/7008) has been retired. Its routes have been migrated to `apps/media`.

## What moved

| Old endpoint | New endpoint |
|---|---|
| `jin.imajin.ai/input/api/transcribe` | `jin.imajin.ai/media/api/transcribe` |
| `jin.imajin.ai/input/api/upload` | `jin.imajin.ai/media/api/assets` |

Audio filename renaming (`blob.webm` → `Audio_YYYY_MM_DD_HH_MM_SS.webm`) is now handled inside the media `/api/assets` POST handler.

## Manual steps

### PM2

```bash
# Development
pm2 delete dev-input

# Production
pm2 delete input
```

### Environment variables

Remove from all `.env.local` files on the server:
```
NEXT_PUBLIC_INPUT_URL
INPUT_SERVICE_URL
```

Add to `apps/media/.env.local` on the server:
```
GPU_NODE_URL=http://192.168.1.124:8765
GPU_AUTH_TOKEN=<your token if set>
```

### Caddy

If an `jin.imajin.ai/input` block exists in the Caddyfile, remove it:

```
# Remove this block:
jin.imajin.ai/input {
  reverse_proxy localhost:7008
}
```

### Ports freed

- `3008` (dev) — available for future `notify` service
- `7008` (prod) — available for future `notify` service
