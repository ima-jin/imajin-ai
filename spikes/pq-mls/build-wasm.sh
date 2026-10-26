#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export RUSTFLAGS='--cfg getrandom_backend="wasm_js"'
cargo build --locked --manifest-path openmls/Cargo.toml --release --target wasm32-unknown-unknown -j 2
wasm-bindgen openmls/target/wasm32-unknown-unknown/release/pq_mls_openmls_spike.wasm \
  --target web --out-dir openmls/pkg
