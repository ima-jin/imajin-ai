# Database Migrations

All 14 services share one Postgres instance. Each service owns its own named schema
(`auth`, `events`, `chat`, etc.) and manages its own migrations via `drizzle-kit`.

---

## Making a schema change

1. Edit `src/db/schema.ts` in the relevant app.
2. From the app directory, generate a migration:

   ```bash
   npm run db:generate
   # or: npx drizzle-kit generate
   ```

3. Review the generated SQL file in `./drizzle/` — make sure it looks right.
4. Commit both `schema.ts` and the new migration file together.

Migrations run automatically on the next deploy (see [Deploy](#deploy-migrations-run-automatically)).

---

## Deploy — migrations run automatically

`scripts/build.sh` runs `drizzle-kit migrate` for every target app **before** building.
If any migration fails, the build aborts — you won't deploy on a broken schema.

The relevant block in `build.sh`:

```bash
for app in "${APPS[@]}"; do
  if [ -f "apps/$app/drizzle.config.ts" ]; then
    cd "apps/$app"
    set -a; source .env.local 2>/dev/null; set +a
    npx drizzle-kit migrate
    cd "$BASE_DIR"
  fi
done
```

You can also run migrations manually with:

```bash
./scripts/migrate.sh              # all apps
./scripts/migrate.sh auth events  # specific apps
```

---

## Setting up a new environment (brownfield baseline)

Because the database already exists, you can't just run `drizzle-kit generate` — it
would produce `CREATE TABLE` statements that fail on existing tables. Instead, use the
baseline script to introspect the live DB and build the snapshot that drizzle-kit needs:

```bash
./scripts/drizzle-baseline.sh              # all apps
./scripts/drizzle-baseline.sh auth events  # specific apps
```

**What it does per app:**

1. `drizzle-kit pull` — connects to the DB and writes a snapshot to `./drizzle/meta/`.
   This snapshot is what drizzle-kit diffs against when you next run `generate`.
2. `drizzle-kit generate` — runs immediately after. If `schema.ts` matches the live DB,
   no migration is produced. Any migration produced here means **drift** between
   `schema.ts` and the actual database — review it carefully.

Requirements: `DATABASE_URL` must be set (loaded from `.env.local` automatically).

---

## Checking for drift

After the baseline is established, you can check whether `schema.ts` matches the DB at
any time:

```bash
cd apps/<app>
npm run db:generate
```

If no migration file is produced, you're in sync. If one is produced, `schema.ts` has
diverged from the last known DB state — either the DB was changed out-of-band or
`schema.ts` has uncommitted additions.

---

## Available npm scripts (all apps)

| Script | Command | Purpose |
|---|---|---|
| `db:generate` | `drizzle-kit generate` | Generate a migration from schema changes |
| `db:migrate` | `drizzle-kit migrate` | Apply pending migrations |
| `db:pull` | `drizzle-kit pull` | Introspect DB and write snapshot |
| `db:studio` | `drizzle-kit studio` | Open Drizzle Studio (local DB browser) |

---

## Old migration directories (to remove)

The following directories contain hand-written SQL migrations from before drizzle-kit
was adopted. They are no longer used and can be deleted once drizzle-kit is confirmed
working in all environments:

- `apps/www/src/db/migrations/`
- `apps/learn/src/db/migrations/`
- `apps/events/migrations/`
- `apps/pay/migrations/`
- `apps/profile/migrations/`
- `apps/chat/src/db/migrations/`
- `apps/auth/migrations/`

Do **not** delete them until the baseline has been successfully run in every environment
(dev and prod) and at least one deploy via `build.sh` has completed successfully.
