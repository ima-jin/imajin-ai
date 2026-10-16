# Signed loop output publisher contract

Kernel #2406 extends the existing #2295 loops rail. The plugin
(`ima-jin/openclaw-imajin-plugin#46`) pushes observations; the kernel never
polls a gateway or reaches into a harness. `/jin` Runs (#2404) is a reader
of the same rail, not a second output store.

## Publish

`POST /api/loops` accepts the existing `{type, payload, publisherDid, signature}`.
`type` remains `loop.started | loop.progress | loop.blocked | loop.finished`.
For output while running, publish `loop.progress`; approval waits may use
`loop.blocked`. Output does not itself execute a tool, approve a request,
spawn a child, or change a model: it records what the publisher observed.

The envelope still requires `loopId`, `kind` (open loop vocabulary, not
the output discriminator), `principal`, `state`, `summary`, and `at`.
Optional fields include `parentLoopId`, `refs`, and now `output`.
`refs` accepts `issue`, `pr`, `runId`, `sessionKey`, and `sessionId`, all
nonempty strings. Keep the original session/run identifiers here. The
publisher chooses a stable deterministic loop ID from its source IDs;
the kernel neither derives IDs nor interprets those source systems.

Sign **the exact original** `canonicalize({type, payload})` with the
publisher's Ed25519 key. Do not add defaults, remove fields, or pre-sign
the storage representation. `signature` is
`{alg:"ed25519", keyId:<64 hex public key>, sig:<128 hex signature>}`.
The kernel checks the registered current key, timestamp window, and
publisher authority (self, node witness, or active `loops:publish` grant)
before redaction or persistence. Existing output-free publishers still work.

Each event carries one `output` object. Supported variants:

- `{"kind":"text","text":"Assistant answer","role":"assistant"}` — `text`
  required; optional role.
- `{"kind":"tool_call","callId":"call_1","name":"search","args":{"query":"loops"}}`
  — tool start, with full JSON arguments.
- `{"kind":"tool_result","callId":"call_1","result":{"hits":3},"isError":false}`
  — tool end, with full JSON result; optional `isError`.
- `{"kind":"artifact","ref":"media_asset_1","name":"report","mediaType":"text/plain"}`
  — publisher-observed artifact reference; `ref` required. The kernel does
  not fetch it, grant access to it, or convert it to a public URL.
- `{"kind":"decision","decision":"Use the bounded queue","reason":"Keep memory bounded"}`
  — decision required, reason optional.
- `{"kind":"approval_request","approvalId":"proposal_1","action":"deploy","details":{"target":"dev"}}`
  — request reference and action required; optional full JSON details.
- `{"kind":"spawn","loopId":"child_loop","principal":"did:imajin:operator"}`
  — child loop reference required; principal optional. Publish the child's
  own lifecycle separately with its `parentLoopId` set.
- `{"kind":"model_change","model":"next-model","previousModel":"old-model","provider":"provider-name"}`
  — model required; previous model and provider optional.

JSON arguments/results/details can be objects, arrays, strings, numbers,
booleans, or null. Preserve call IDs across start/end and publish every
observation. There is no polling, deduplication, or exactly-once promise:
a successful repeat publish is another history event.

## Redaction and limits

The signed original is verified in memory. Persistence receives only the
sanitized envelope: nested secret-bearing keys and credential-shaped text
(including provider API keys, bearer/JWT credentials, private-key material,
and connection-URL credentials) are redacted. This applies to summaries,
refs, output, previews, and stored artifacts. Publishers must still avoid
sending secrets: heuristic redaction is defense in depth, not a guarantee
that every arbitrary secret can be recognized.

The HTTP request cap is **1,048,576 UTF-8 bytes**, counted while streaming,
even without or with a false Content-Length. Larger requests return 413.
Split larger source output into multiple observations before signing.
Envelope metadata and JSON nesting are additionally bounded at validation.
The inline output cap is **16,384 UTF-8 JSON bytes after redaction**.
Output above it is stored in `kernel.loop_output_artifacts` and replaced by:

```json
{
  "kind": "tool_result",
  "artifactRef": {
    "id": "<content-addressed id>",
    "sha256": "<hash of the redacted canonical JSON>",
    "byteLength": 20000,
    "mediaType": "application/json"
  },
  "preview": "<bounded redacted preview>",
  "truncated": true
}
```

`kind` stays the original output kind. `preview` is display text, not a JSON
document. Only the kernel constructs this storage wrapper; publishers
cannot submit `artifactRef`/`truncated` wrappers as output. The artifact
contains the **full redacted output**, not the unredacted signed original.
Hashes identify content and are never authorization capabilities.

201 means the event history/projection write completed. 400 means invalid
shape, signature, or timestamp; 403 means the publisher lacks authority;
409 means the loop ID is already owned by another principal; 500 means
storage/publication failed. Ownership is immutable once reserved; a failed
first publish can leave a reserved projection but no completed history.
Retry with the same principal, never by transferring the loop ID.

## Read from Runs

`GET /api/loops/{loopId}` returns the unchanged `{loop, events}` outer shape.
Events are ordered by `(occurredAt, id)` ascending (stable for equal
timestamps; not a claim about source ordering within one timestamp).
Each event exposes `payload.output`, either a typed inline variant or the
storage wrapper. Lifecycle-only events have no output; keep them in the
timeline. The camelCase record includes `id`, `loopId`, `type`, `issuer`,
`principal`, `payload`, `occurredAt`, and `createdAt`.

On an overflow wrapper, fetch
`GET /api/loops/{loopId}/artifacts/{artifactRef.id}` using the same authenticated
session/acting principal. Response:
`{id, sha256, byteLength, mediaType, output}`. Render the full typed `output`
after retrieval. Do not derive media-service URLs from the hash.

Both history and artifact lookup are scoped to the caller's effective DID
through existing auth; wrong-principal, wrong-loop, and nonexistent
resources all return 404. Artifact and detail responses use
`Cache-Control: private, no-store`. No new environment variables, external
storage service, or gateway credentials are required.
