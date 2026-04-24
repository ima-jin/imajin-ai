#!/bin/bash
set -e
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE_DIR"
node scripts/migrate.mjs "$@"
