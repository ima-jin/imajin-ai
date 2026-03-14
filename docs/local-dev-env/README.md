# Local Dev Environment

Drop these `.env.local` files into each `apps/*/` directory to run services locally
while connecting to the dev backend on the ProLiant.

## Setup

1. `pnpm install` from repo root
2. SSH tunnel for the DB: `ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193`
3. Copy the `.env.local` file for whichever app you want to work on into its `apps/*/` directory
4. Fill in the secrets marked `CHANGE_ME` (get from server's `.env.local` files or ask Jin)
5. `cd apps/whatever && pnpm dev`

## What's wired up

- `DATABASE_URL` → goes through SSH tunnel to server Postgres
- `NEXT_PUBLIC_*` URLs → point at running `dev-*.imajin.ai` services
- Internal `*_SERVICE_URL` → also point at `dev-*.imajin.ai`
- Secrets → placeholders only, fill in yourself

## The hybrid model

Your local app runs on `localhost:PORT` with hot reload.
Everything it talks to (auth, pay, etc.) hits the real dev services on the server.
Best of both worlds — fast CSS iteration, real backend.
