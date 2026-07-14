#!/usr/bin/env bash
# setup-local.sh — Local development setup for imajin-ai
#
# Usage: ./scripts/setup-local.sh [options]
#
# Options:
#   --db-user=USER      Postgres user  (default: $PGUSER or current user)
#   --db-host=HOST      Postgres host  (default: localhost)
#   --db-port=PORT      Postgres port  (default: 5432)
#   --db-name=NAME      Database name  (default: imajin_dev)
#   --force             Overwrite existing .env.local files (re-generates secrets)
#   --skip-install      Skip pnpm install
#   --skip-migrate      Skip database migrations
#   -h, --help          Show this help

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Colour helpers ────────────────────────────────────────────────────────────
bold()  { printf '\033[1m%s\033[0m' "$*"; }
green() { printf '\033[32m%s\033[0m' "$*"; }
yellow(){ printf '\033[33m%s\033[0m' "$*"; }
red()   { printf '\033[31m%s\033[0m' "$*"; }
cyan()  { printf '\033[36m%s\033[0m' "$*"; }
dim()   { printf '\033[2m%s\033[0m' "$*"; }

step()  { echo; echo "$(bold "▶  $*")"; }
ok()    { echo "  $(green "✔")  $*"; }
warn()  { echo "  $(yellow "⚠")  $*"; }
err()   { echo "  $(red "✘")  $*" >&2; }

# ── Defaults ──────────────────────────────────────────────────────────────────
DB_USER="${PGUSER:-$(id -un 2>/dev/null || echo "postgres")}"
DB_HOST="${PGHOST:-localhost}"
DB_PORT="${PGPORT:-5432}"
DB_NAME="imajin_dev"
FORCE=false
SKIP_INSTALL=false
SKIP_MIGRATE=false

# ── Arg parsing ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --force)          FORCE=true ;;
    --skip-install)   SKIP_INSTALL=true ;;
    --skip-migrate)   SKIP_MIGRATE=true ;;
    --db-user=*)      DB_USER="${arg#*=}" ;;
    --db-host=*)      DB_HOST="${arg#*=}" ;;
    --db-port=*)      DB_PORT="${arg#*=}" ;;
    --db-name=*)      DB_NAME="${arg#*=}" ;;
    -h|--help)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
      exit 0
      ;;
    *) err "Unknown option: $arg"; exit 1 ;;
  esac
done

DATABASE_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# ── Portable sed -i ───────────────────────────────────────────────────────────
sed_inplace() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    sed -i '' "$@"
  else
    sed -i "$@"
  fi
}

# Set or replace a key=value line in an env file.
# Handles both quoted (KEY="val") and bare (KEY=val) existing values.
set_env() {
  local file="$1" key="$2" value="$3"
  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed_inplace "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s' "$key" "$value" >> "$file"
  fi
}

# ── Secret generation ─────────────────────────────────────────────────────────
# 32 random bytes as hex — uses Node.js (always available in this repo)
gen_secret() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
}

# Ed25519 private key in PKCS#8 DER hex format (96 hex chars, used for JWT signing)
gen_ed25519_key() {
  node -e "
    const kp = require('node:crypto').generateKeyPairSync('ed25519');
    process.stdout.write(kp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'));
  "
}

# ── Prerequisite checks ───────────────────────────────────────────────────────
echo
echo "$(bold "$(cyan "imajin-ai")") $(bold "local dev setup")"
echo "$(dim "────────────────────────────────────────────────────────────")"

step "Checking prerequisites"

# Node.js 22+
if ! command -v node &>/dev/null; then
  err "Node.js not found. Install Node.js 22+ → https://nodejs.org"; exit 1
fi
NODE_VER=$(node -e "process.stdout.write(process.version)")
NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  err "Node.js 22+ required (found $NODE_VER). Use nvm to upgrade."; exit 1
fi
ok "Node.js $NODE_VER"

# pnpm
if ! command -v pnpm &>/dev/null; then
  err "pnpm not found. Run: npm install -g pnpm"; exit 1
fi
ok "pnpm $(pnpm --version)"

# PostgreSQL client tools (need createdb or psql)
if ! command -v createdb &>/dev/null && ! command -v psql &>/dev/null; then
  err "PostgreSQL client tools not found. Install PostgreSQL 14+."; exit 1
fi
ok "PostgreSQL client tools"

# ── Install dependencies ──────────────────────────────────────────────────────
if [[ "$SKIP_INSTALL" != true ]]; then
  step "Installing dependencies"
  pnpm install --frozen-lockfile
  ok "Dependencies installed"
fi

# ── Database ──────────────────────────────────────────────────────────────────
step "Setting up database"
echo "  $(dim "${DATABASE_URL}")"

DB_EXISTS=false
if psql -U "$DB_USER" -h "$DB_HOST" -p "$DB_PORT" -lqt 2>/dev/null \
     | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
  DB_EXISTS=true
  ok "Database '${DB_NAME}' already exists"
else
  if createdb -U "$DB_USER" -h "$DB_HOST" -p "$DB_PORT" "$DB_NAME" 2>/dev/null; then
    ok "Created database '${DB_NAME}'"
  else
    err "Could not create database '${DB_NAME}'."
    echo
    echo "  Try one of:"
    echo "    sudo -u postgres createdb ${DB_NAME}"
    echo "    createdb --username=postgres ${DB_NAME}"
    echo "    psql -c \"CREATE DATABASE ${DB_NAME};\" postgres"
    exit 1
  fi
fi

# ── Generate secrets ──────────────────────────────────────────────────────────
step "Generating secrets"

AUTH_PRIVATE_KEY=$(gen_ed25519_key)
ATTESTATION_KEY=$(gen_secret)
AUTH_INTERNAL_KEY=$(gen_secret)
GROUP_KEY_SECRET=$(gen_secret)
MEDIA_INTERNAL_KEY=$(gen_secret)
TRUST_INTERNAL_KEY=$(gen_secret)
NOTIFY_SECRET=$(gen_secret)
PAY_API_KEY=$(gen_secret)

ok "Ed25519 AUTH_PRIVATE_KEY"
ok "Shared internal API keys (ATTESTATION, AUTH, NOTIFY, PAY)"
ok "Kernel-only secrets (GROUP_KEY, MEDIA, TRUST)"

# ── Copy and patch .env.local files ──────────────────────────────────────────
step "Writing .env.local files"

# Apps with .env.example files (broker-agent handled separately below)
APPS=(kernel events coffee dykil links learn market)

for app in "${APPS[@]}"; do
  app_dir="$REPO_ROOT/apps/$app"
  example="$app_dir/.env.example"
  local_env="$app_dir/.env.local"

  [[ -f "$example" ]] || continue

  if [[ -f "$local_env" && "$FORCE" != true ]]; then
    warn "$app/.env.local already exists (use --force to overwrite)"
    continue
  fi

  cp "$example" "$local_env"

  # ── All apps: database, runtime ────────────────────────────────────────────
  set_env "$local_env" "DATABASE_URL" "\"${DATABASE_URL}\""
  set_env "$local_env" "NODE_ENV" "development"
  set_env "$local_env" "IMAJIN_ENV" "dev"

  if [[ "$app" == "kernel" ]]; then
    # ── Kernel: secrets ────────────────────────────────────────────────────
    set_env "$local_env" "AUTH_PRIVATE_KEY"              "\"${AUTH_PRIVATE_KEY}\""
    set_env "$local_env" "GROUP_KEY_ENCRYPTION_SECRET"   "\"${GROUP_KEY_SECRET}\""
    set_env "$local_env" "MEDIA_INTERNAL_API_KEY"        "\"${MEDIA_INTERNAL_KEY}\""
    set_env "$local_env" "TRUST_INTERNAL_API_KEY"        "\"${TRUST_INTERNAL_KEY}\""
    set_env "$local_env" "ATTESTATION_INTERNAL_API_KEY"  "\"${ATTESTATION_KEY}\""
    set_env "$local_env" "AUTH_INTERNAL_API_KEY"         "\"${AUTH_INTERNAL_KEY}\""
    set_env "$local_env" "NOTIFY_WEBHOOK_SECRET"         "\"${NOTIFY_SECRET}\""
    set_env "$local_env" "PAY_SERVICE_API_KEY"           "\"${PAY_API_KEY}\""

    # ── Kernel: local dev public URLs ──────────────────────────────────────
    set_env "$local_env" "NEXT_PUBLIC_SERVICE_PREFIX"    "http://localhost:"
    set_env "$local_env" "NEXT_PUBLIC_DISABLE_INVITE_GATE" "true"
    set_env "$local_env" "NEXT_PUBLIC_BASE_URL"          "http://localhost:3000"
    set_env "$local_env" "NEXT_PUBLIC_APP_URL"           "http://localhost:3000/chat"
    set_env "$local_env" "NEXT_PUBLIC_AUTH_URL"          "http://localhost:3000/auth"
    set_env "$local_env" "NEXT_PUBLIC_WWW_URL"           "http://localhost:3000"
    set_env "$local_env" "NEXT_PUBLIC_CHAT_URL"          "http://localhost:3000/chat"
    set_env "$local_env" "NEXT_PUBLIC_CONNECTIONS_URL"   "http://localhost:3000/connections"
    set_env "$local_env" "NEXT_PUBLIC_PAY_URL"           "http://localhost:3000/pay"
    set_env "$local_env" "NEXT_PUBLIC_PROFILE_URL"       "http://localhost:3000/profile"
    set_env "$local_env" "NEXT_PUBLIC_REGISTRY_URL"      "http://localhost:3000/registry"
    set_env "$local_env" "NEXT_PUBLIC_MEDIA_SERVICE_URL" "http://localhost:3000/media"
    set_env "$local_env" "NEXT_PUBLIC_MEDIA_URL"         "http://localhost:3000/media"
    set_env "$local_env" "NEXT_PUBLIC_NOTIFY_URL"        "http://localhost:3000/notify"
    set_env "$local_env" "NEXT_PUBLIC_EVENTS_URL"        "http://localhost:3006"
    set_env "$local_env" "NEXT_PUBLIC_COFFEE_URL"        "http://localhost:3100"
    set_env "$local_env" "NEXT_PUBLIC_DYKIL_URL"         "http://localhost:3101"
    set_env "$local_env" "NEXT_PUBLIC_LINKS_URL"         "http://localhost:3102"
    set_env "$local_env" "NEXT_PUBLIC_LEARN_URL"         "http://localhost:3103"
    set_env "$local_env" "NEXT_PUBLIC_MARKET_URL"        "http://localhost:3104"

    ok "kernel/.env.local"

  else
    # ── Userspace apps: fix stale service URLs from old multi-port arch ────
    # All kernel sub-services are now consolidated at :3000 with path prefixes.
    set_env "$local_env" "AUTH_SERVICE_URL"         "http://localhost:3000/auth"
    set_env "$local_env" "AUTH_URL"                 "http://localhost:3000/auth"
    set_env "$local_env" "PAY_SERVICE_URL"          "http://localhost:3000/pay"
    set_env "$local_env" "PROFILE_SERVICE_URL"      "http://localhost:3000/profile"
    set_env "$local_env" "PROFILE_URL"              "http://localhost:3000/profile"
    set_env "$local_env" "CONNECTIONS_SERVICE_URL"  "http://localhost:3000/connections"
    set_env "$local_env" "CHAT_SERVICE_URL"         "http://localhost:3000/chat"
    set_env "$local_env" "MEDIA_SERVICE_URL"        "http://localhost:3000/media"
    set_env "$local_env" "NOTIFY_SERVICE_URL"       "http://localhost:3000/notify"
    set_env "$local_env" "REGISTRY_URL"             "http://localhost:3000/registry"

    # ── Shared secrets (must match kernel) ─────────────────────────────────
    set_env "$local_env" "ATTESTATION_INTERNAL_API_KEY" "\"${ATTESTATION_KEY}\""
    set_env "$local_env" "AUTH_INTERNAL_API_KEY"        "\"${AUTH_INTERNAL_KEY}\""

    case "$app" in
      events|coffee)
        set_env "$local_env" "NOTIFY_WEBHOOK_SECRET" "\"${NOTIFY_SECRET}\""
        ;;
    esac

    case "$app" in
      events|market)
        set_env "$local_env" "PAY_SERVICE_API_KEY" "\"${PAY_API_KEY}\""
        ;;
    esac

    ok "${app}/.env.local"
  fi
done

# ── Broker agent: local kernel URL only ──────────────────────────────────────
BROKER_EXAMPLE="$REPO_ROOT/apps/broker-agent/.env.example"
BROKER_LOCAL="$REPO_ROOT/apps/broker-agent/.env.local"
if [[ -f "$BROKER_EXAMPLE" ]]; then
  if [[ -f "$BROKER_LOCAL" && "$FORCE" != true ]]; then
    warn "broker-agent/.env.local already exists (use --force to overwrite)"
  else
    cp "$BROKER_EXAMPLE" "$BROKER_LOCAL"
    set_env "$BROKER_LOCAL" "KERNEL_URL" "http://localhost:3000"
    ok "broker-agent/.env.local (fill in TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, APP_DID, APP_PRIVATE_KEY)"
  fi
fi

# ── Database migrations ───────────────────────────────────────────────────────
if [[ "$SKIP_MIGRATE" != true ]]; then
  step "Running database migrations"
  if bash "$REPO_ROOT/scripts/migrate.sh"; then
    ok "Migrations complete"
  else
    err "Migrations failed — check DATABASE_URL in apps/kernel/.env.local"
    exit 1
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo
echo "$(dim "────────────────────────────────────────────────────────────")"
echo "$(green "$(bold "✔  Setup complete!")")"
echo
echo "  $(bold "Next steps:")"
echo
echo "  1. $(cyan "Start kernel")"
echo "     pnpm --filter @imajin/kernel dev     $(dim "→ http://localhost:3000")"
echo
echo "  2. $(cyan "Register your first identity")"
echo "     Open http://localhost:3000/register in your browser"
echo "     $(dim "Save your key file — it is the only copy.")"
echo
echo "  3. $(cyan "Start verticals as needed")"
echo "     pnpm --filter @imajin/events dev     $(dim "→ http://localhost:3006")"
echo "     pnpm --filter @imajin/coffee dev     $(dim "→ http://localhost:3100")"
echo "     pnpm --filter @imajin/dykil  dev     $(dim "→ http://localhost:3101")"
echo "     pnpm --filter @imajin/links  dev     $(dim "→ http://localhost:3102")"
echo "     pnpm --filter @imajin/learn  dev     $(dim "→ http://localhost:3103")"
echo "     pnpm --filter @imajin/market dev     $(dim "→ http://localhost:3104")"
echo
echo "  $(dim "Optional: fill in Stripe, SendGrid, Anthropic, etc. in apps/kernel/.env.local")"
echo
