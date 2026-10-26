# ADR-3112: one OpenMLS/libcrux wasm build for web and Node
Date: 2026-10-26. Status: proposed for review. Parent: [#1070](https://github.com/ima-jin/imajin-ai/issues/1070).
Evidence and commands: [isolated spike](../../spikes/pq-mls/README.md).

## Decision
Choose **OpenMLS 0.9.2 + openmls_libcrux_crypto 0.4.0**, compiled to wasm,
for both the web client and the OpenClaw plugin's Node 24 runtime.
Pin all OpenMLS workspace crates to commit
**`8a8f83b4b61fc45f28facec25e914992b3465de6`** (`v0.9.2`), the committed
`spikes/pq-mls/openmls/Cargo.lock`, Rust **1.99.1**, and wasm-bindgen **0.2.129**.
Use the same generated wasm bytes in both runtimes, not independent npm/Rust
version ranges. This ADR specifies the plugin pin; it does not modify that repo.

The only allowed suite is
**`MLS_256_XWING_CHACHA20POLY1305_SHA256_Ed25519`**, experimental MLS
code point **`0x004d` (77)**: X25519 + ML-KEM-768, ChaCha20-Poly1305, SHA-256,
Ed25519. Restrict KeyPackage capabilities and group creation to this suite;
reject other suite IDs. There is **no classic-only or pure-ML-KEM fallback**.
MLS selects a suite at group creation rather than TLS-style negotiation:
the tests check both members retain the exact chosen suite after Welcome.

Why: both candidates work, but OpenMLS has independent protocol review,
explicit provider/storage boundaries, an established conformance corpus, and
libcrux's high-assurance primitive implementations. That is preferable to an
unaudited protocol implementation for the security-sensitive chat upgrade.
The larger download and Rust/wasm build pipeline are accepted costs. This
is a library choice, **not authorization to ship this test binding**.

## Runtime evidence
Both candidates pass automated **create → add → serialized Welcome → join →
further commit received by the existing member → application messages** in
**Node 24.0.0** and **real Chromium 156.0.0.0 on Linux**, not jsdom.
Each decrypts 0-, 32-, and 1024-byte payloads; both reject modified ciphertext
and replay. The identical OpenMLS wasm artifact is loaded via bytes in Node
and via HTTP in Chromium. Browser results and screenshots are attached to the PR.

- OpenMLS **0.9.2**, pinned above: Node **PASS**, browser **PASS**.
- ts-mls **1.6.4**: Node **PASS**, browser **PASS**. JS pins, including
  `@hpke/hybridkem-x-wing` **0.7.0**, are in the spike manifest and root lockfile.
  It remains the evaluated alternative, not a second production implementation.
- Chosen-library suite guard rejects classic `0x0001` and pure ML-KEM `0xf042`.
- Tampered-message rejection followed by successful decryption of the original
  **same-generation** message passes. An initial OpenMLS 0.9.0 trial failed this
  regression, matching [GHSA-p276-g3f3-wwgh](https://github.com/openmls/openmls/security/advisories/GHSA-p276-g3f3-wwgh);
  it was rejected and replaced with 0.9.2, not worked around.

No app/kernel code imports the spike. Credentials are ephemeral basic test
identities, not DID-attested per-device leaves. No history transfer, production
storage, delivery service, or plugin integration is implemented here.

## RFC 9420 conformance evidence
`bash spikes/pq-mls/test-vectors.sh` pins the same upstream revision and runs
**99 passing test functions**, zero failures: 96 in `::kats::`, one
`kat_crypto_basics`, one `kat_treemath`, and one `kat_vl`.
These consume upstream's committed vector fixtures: crypto basics, key
schedule, PSK secret, secret tree, message protection, transcript hashes, tree
math/operations/validation/KEM, messages, deserialization, Welcome and passive
clients. A test function can consume many vector cases.

Scope matters: some upstream vector runners hard-code RustCrypto and skip
unsupported classical suites. This is evidence for OpenMLS's RFC 9420 protocol
implementation, **not** a claim that the RFC defines the experimental X-Wing
suite or that every vector ran through libcrux/wasm. The separate Node/browser
round-trips exercise X-Wing through libcrux. Classical conformance fixtures are
test inputs only and cannot enable a runtime fallback.

## Size and wire overhead
Measured with Rust release `opt-level=s`, LTO, no wasm-opt; esbuild **0.25.12**,
minified ES2022 ESM, gzip level 9. Sizes include the test binding and are not a
promise for a future production API.

- OpenMLS wasm: **2,614,928 bytes raw / 570,992 bytes gzip**.
- OpenMLS generated JS loader: **6,404 raw / 1,900 gzip**.
- OpenMLS total wasm + loader: **572,892 bytes gzip (~559.5 KiB)**.
- TypeScript browser harness: **303,935 raw / 92,118 gzip (~90.0 KiB)**.
  This conservatively includes the test driver, OpenMLS loading stub, and
  optional algorithm branches bundled by ts-mls; it excludes the wasm/loader.

Encoded MLSMessage measurements, identical across Node and Chromium:
- OpenMLS: plaintext 0 → wire 141 (**141 overhead**); 32 → 173 (**141**);
  1024 → 1166 (**142**). Add commit **5412**, Welcome **5419** bytes.
- ts-mls: plaintext 0 → wire 330 (**330 overhead**); 32 → 330 (**298**);
  1024 → 1166 (**142**). Welcome **1595**; sampled add commits **2857–2873**
  bytes (library randomness/identifiers vary).

No transport framing, JSON, or base64 is counted. Group ID is `pq-mls-spike`,
with two basic-credential members. ts-mls defaults to padding short content to
256 bytes; OpenMLS uses no extra padding. The comparison is not a normalized
padding benchmark. PQ key/ciphertext costs appear primarily in KeyPackages,
Welcome and update paths, not a new ML-KEM ciphertext on every application
message. Larger groups and future credential payloads need new measurements.

## Code points and migration
As checked on this date, the [IANA MLS registry](https://www.iana.org/assignments/mls/mls.xhtml)
has no assignment for these experimental PQ suites;
[draft-ietf-mls-pq-ciphersuites-06](https://datatracker.ietf.org/doc/draft-ietf-mls-pq-ciphersuites/)
is publication-requested, not an assigned RFC suite set.
OpenMLS's `0x004d` is **not an IANA allocation**. ts-mls 1.6.4 uses
`0x0053` (83) for X-Wing/AES256GCM/SHA512/Ed25519 and `0x0054` (84) for
its ChaCha/SHA512 alternative. OpenMLS's SHA256 suite differs in primitives
as well as number; simply rewriting an ID cannot make these implementations
interoperate. The newer ts-mls development branch also changes experimental
IDs, another reason not to use unpinned ranges.

Pinning one engine/build across web and plugin avoids that split. Keep the
suite ID in group metadata; reject unknown/disallowed suites. When assigned
suites stabilize, migrate with a reviewed **MLS ReInit**, not an ID alias or
silent downgrade. That belongs to the later ciphersuite-agility child of #1070.

## Audit and signature readiness
OpenMLS has an [SRLabs independent audit](https://blog.openmls.tech/posts/2026-05-27-independent-audit/).
That review is not a certification of this exact 0.9.2/PQ/wasm combination.
libcrux uses formal methods for crypto components; this does **not** prove the
whole MLS protocol, HPKE glue, compiler, bindings, JS host, or application.
Review [upstream advisories](https://github.com/openmls/openmls/security/advisories)
on every pin change. The chosen release includes fixes for the rejected-message
ratchet, removed-leaf reappearance, and nested-extension recursion advisories.
ts-mls 1.6.4 explicitly states it has **not undergone a formal security audit**.

Ed25519 stays mandatory for signatures per #1070: hybrid PQ confidentiality
does not provide PQ authentication. OpenMLS's types contain draft ML-DSA suite
identifiers, but this pinned **libcrux provider only accepts Ed25519** for
signatures; those identifiers are not working ML-DSA support in this provider.
ts-mls advertises ML-DSA-87 suites via its optional noble provider; those suites
were not exercised here. Neither candidate's tested configuration demonstrates
a classical+PQ hybrid-signature credential chain. Defer signature migration
until the DID chain supports hybrid keys (#2010), then re-evaluate provider
support, signature sizes, test vectors and ReInit policy.

## Stop rule
The stop condition is **not triggered**: both candidates pass X-Wing in both
runtimes. If a future pinned build cannot do so, stop and raise the #3112
DECISION card; do not replace X-Wing with a classic-only suite.
