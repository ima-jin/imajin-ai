#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
revision=8a8f83b4b61fc45f28facec25e914992b3465de6
upstream="${OPENMLS_VECTOR_CHECKOUT:-$PWD/openmls/target/upstream}"
if [[ ! -d "$upstream/.git" ]]; then
  git clone https://github.com/openmls/openmls.git "$upstream"
  git -C "$upstream" checkout --detach "$revision"
fi
[[ "$(git -C "$upstream" rev-parse HEAD)" == "$revision" ]]
export CARGO_PROFILE_TEST_DEBUG=0 CARGO_PROFILE_DEV_DEBUG=0
for category in ::kats:: kat_crypto_basics kat_treemath kat_vl; do
  cargo test --manifest-path "$upstream/Cargo.toml" --locked -j 2 -p openmls --lib \
    --features libcrux-provider,all-ciphersuites,draft-ietf-mls-pq-ciphersuites -- "$category"
done
