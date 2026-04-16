#!/bin/bash
set -e
export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE_DIR"
node scripts/migrate.mjs "$@"
