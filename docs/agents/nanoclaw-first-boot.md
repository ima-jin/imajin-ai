# NanoClaw first boot

This guide describes the NanoClaw integration code and its current readiness
limits. It is not evidence of a deployed instance or permission to start one.
NanoClaw remains a separate harness: the kernel receives authenticated messages,
signed events and usage, never reads a harness transcript or calls gateway RPC.

## Components

- `packages/claw-envelope` renders a NanoClaw envelope and provides identity
  bootstrap. The agent has its own DID/keypair and explicit principal grants.
- `packages/nanoclaw-imajin-channel` supplies the channel adapter plus MCP and
  usage-emitter sidecars. The adapter authenticates as the agent and connects
  to the kernel's chat WebSocket; replies do not impersonate the human owner.
- `packages/openclaw-infer-passthrough` forwards inference using its selected
  authentication mode. The default requires the calling agent's own JWT.
- `deploy/nanoclaw/` supplies build files and a four-service Compose example:
  NanoClaw, inference passthrough, MCP proxy and usage emitter. NanoClaw uses the
  host Docker socket to create separate per-conversation containers.

Read the [auth](https://jin.imajin.ai/auth/api/spec),
[inference](https://jin.imajin.ai/infer/api/spec),
[chat](https://jin.imajin.ai/chat/api/spec) and
[usage](https://jin.imajin.ai/usage/api/spec) specifications for wire contracts.
The [envelope provisioner guide](envelope-provisioner.md) documents the existing
provisioning rail; it is not proof that this example stack is deploy-ready.

## Readiness gate: the supplied inference wiring is not compatible

The checked-in Compose example sets `ANTHROPIC_API_KEY=unused-placeholder` and
provides host signing variables to the inference sidecar, but does not select
`INFER_PROXY_AUTH_MODE=host-static`. The proxy defaults to `agent` and rejects a
placeholder with 401. Setting a base URL alone therefore does not make the
current example a working agent integration.

Agent mode requires a refreshed per-calling-agent `app+jwt` and, when selecting
an assigned organization, its verified `x-acting-as`. The proxy never mints,
re-mints, caches a shared catalog or falls back to a direct provider key on this
lane. A static container header is not a token-refresh mechanism. Do not resolve
this by selecting host-static for agent traffic or installing a shared provider
key. The harness-side credential integration must agree with the kernel's
[calling-agent contract](../../deploy/infer-passthrough/README.md#calling-agent-contract)
before claiming a successful first boot.

The NanoClaw MCP sidecar is also an explicit compatibility check: its token
provider uses `attestationId` and scope `mcp`, whereas the current principal-based
mint and resource audience must match the kernel's actual MCP contract. Do not
assume a sidecar health response proves authenticated tool execution. Review its
`src/mcp-proxy/token-provider.ts` and the
[MCP runbook](../ops/openclaw-mcp.md) before deployment.

## Operator preparation

The adapter build seam uses NanoClaw's `ChannelAdapter` interface and its
`src/channels/index.ts` registration barrel. The envelope supplies
`groups/<folder>/container.json` for the runner, whose MCP HTTP configuration
has static headers. Persona input is `instructions.prepend.md` plus the harness's
`memory/` convention, composed into `CLAUDE.md`; OpenClaw workspace filenames
are not interchangeable with these. Check the pinned upstream ref's interfaces
before building, since source support is not a deployed-harness guarantee.

The chat adapter signs the agent's login challenge, establishes its own session
and persistent `/chat/ws` connection, and sends replies through the agent chat
contract without impersonating its owner. Minimal delegation comes from the
existing capability registry; emitter registration remains an owner action.
The usage sidecar tails the harness-owned session JSONL under its bind-mounted
data path and persists its own deduplication state. These local harness reads do
not grant the kernel transcript access. The Docker build pins `NANOCLAW_GIT_REF`;
the host process needs controlled Docker-socket access and the matching host
socket group, not an assumption that every container runs as root.

The envelope renderer also recognizes explicit `brain.via: 'direct'` and model
placement/provider configuration. These describe a separate operator-selected
brain path, not an automatic fallback from rejected kernel agent credentials or
proof of kernel metering. The usage emitter reports source `harness:nanoclaw`
and uses external-id deduplication; do not turn that observation into a second
charge or assume it always exists for each kernel-observed call.

Pin the upstream NanoClaw commit used by the Docker build. Check its actual
extension/config interfaces at that ref rather than assuming another harness's
workspace filenames or provider hooks apply. Keep the channel adaptation in the
supported adapter/build seam; do not patch an upstream source tree ad hoc.

Register the agent through the existing authorized agent flow, preserving the
selected principal and real human controller. A personal grant does not authorize
an org assignment. Keep returned key material in protected credential storage;
never extract it into a shell command or log. Render the envelope with the real
agent DID and review generated non-secret settings before staging them.

Owner consent for tools/inference and emitter registration remain explicit.
Registration alone grants no connector authority. Check the active principal,
agent DID, audience, capabilities and expiry, and use the owning service's
current contracts instead of copying a stored grant/attestation id as authority.

Review container networking and Docker-socket authority. Spawned agent containers
are siblings, not members of the host's network namespace. They must reach the
intended internal services on the named `nanoclaw-net` network; localhost inside
a container is not another sidecar. Do not expose credential-bearing sidecars
publicly or treat a socket existence healthcheck as an end-to-end test.

## Verification after compatible wiring exists

An authorized operator must prove a DM round trip under the agent DID, a scoped
MCP tool call and a model completion with the expected signer/principal. Verify
a refusal with missing credentials and with revoked authority, with no fallback
to personal/shared credentials. Source tests or an image build are not this proof.

The usage sidecar reads the harness's own local session files outside the kernel
and submits usage through the public contract. Kernel inference metering and
harness observations have different provenance; correlate ids and inspect costs
before aggregating. Do not promise exactly two records per turn or infer free
usage from absent pricing. Confirm a zero-cost observation is retained when the
emitter reports one, without importing raw transcript text into kernel history.

For pause/decommission, stop the owned processes and explicitly revoke grants,
app consent and emitter authority as appropriate. Keep the DID, signed history
and revoked rows. Do not delete ledger records or remove independent harness
containers without checking their ownership.

The Compose and sidecar incompatibilities require separately scoped code work.
This guide stays as the integration/readiness checklist rather than a claim that
changing two environment lines completes a live deployment.
