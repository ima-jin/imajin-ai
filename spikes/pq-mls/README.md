# PQ-MLS spike (#3112)
Isolated automated assertions; imported by no app, kernel, or shared production
package. No database, credentials, environment secrets, or app server needed.
The new workspace has no `build`, `test`, or `typecheck` Turbo task: app builds
do not compile Rust or run this experiment. Run its commands explicitly.

## Prerequisites
Node **24**, pnpm **9.15.0**, Rust **1.99.1**, target
`wasm32-unknown-unknown`, and **wasm-bindgen-cli 0.2.129** on `PATH`.
Install the CLI with `cargo install wasm-bindgen-cli --version 0.2.129 --locked`,
or use its matching upstream release binary. Rust is pinned in
`rust-toolchain.toml`; all Rust/JS dependency resolutions are committed.

## Build and Node tests (from repository root)
```sh
pnpm install --frozen-lockfile --loglevel=error
bash spikes/pq-mls/build-wasm.sh
pnpm --filter @imajin-spike/pq-mls check:types
pnpm --filter @imajin-spike/pq-mls test:node
pnpm --filter @imajin-spike/pq-mls bundle
```
Both candidates create a group, add Bob via serialized Welcome, apply a further
commit at the existing member, and decrypt 0/32/1024-byte application messages.
Assertions reject altered ciphertext and replay. OpenMLS also asserts the
original same-generation ciphertext still succeeds after the altered one was
rejected (GHSA-p276-g3f3-wwgh regression). No identity-authentication guarantee is
claimed: these are ephemeral **basic test credentials**, not DID attestations.
Nothing prints key material.

## Real-browser automated assertions
After the build above, serve the **static test files only**:
```sh
python3 -m http.server 8312 --bind 127.0.0.1 --directory spikes/pq-mls/dist
```
Open `http://127.0.0.1:8312/` in Chromium. The module automatically runs the same
assertions as Node; both rows must say `PASS` and the title must become
`PQ-MLS PASS`. Any thrown assertion produces `FAIL`. This is not jsdom, and does
not run any monorepo application. In this evaluation it ran in real Chromium 156;
browser evidence is attached to the PR. Browser launching is not part of the
root Vitest suite or CI; the assertions themselves run automatically in the page.

## RFC 9420 vectors
```sh
bash spikes/pq-mls/test-vectors.sh
```
This checks out the **exact OpenMLS 0.9.2 revision** inside ignored build output
and runs its committed vector fixtures with the pinned upstream Cargo.lock:
`::kats::`, `kat_crypto_basics`, `kat_treemath`, and `kat_vl` (99 test functions).
To reuse an existing checkout, set `OPENMLS_VECTOR_CHECKOUT` to its absolute
path; the script refuses a different revision. These RFC suites use classical
fixture suites where the upstream runner specifies them; this is conformance
testing, **not a runtime downgrade or evidence of an RFC-standard X-Wing suite**.
Some upstream vector runners hard-code RustCrypto; the X-Wing runtime tests
separately exercise libcrux in the identical wasm artifact in browser and Node.

## Measurements and interpretation
`bundle` prints raw and gzip-level-9 bytes for the TS harness and OpenMLS
JS/wasm files. Node/browser tests print **encoded MLSMessage** sizes and overhead
(`wire - plaintext`), excluding transport framing/base64. ts-mls pads short
messages to 256 bytes internally by default; OpenMLS uses zero extra padding.
Commit size may vary with library-generated identifiers and randomness.
These are two-member samples, not universal group-size limits.

See [ADR-3112](../../docs/adr/3112-pq-mls.md) for the selected pin, security
scope, code-point incompatibility, and future migration requirements.
