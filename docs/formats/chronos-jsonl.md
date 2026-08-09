# Chronos JSONL v1

Chronos JSONL is the one import format Chronos defines itself. It exists so
that importing, branching, and exporting can be exercised end to end before any
provider transcript format has been observed. Adapters for real agents are
written only from observed fixtures, never from a guessed schema.

A file is UTF-8 [newline-delimited JSON](https://jsonlines.org/): one JSON
object per line. Blank lines are ignored. Every record is a tagged object with
a `type` and a `schemaVersion`, and the current `schemaVersion` is `1`.

## Record order

```text
session          exactly once, the first record in the file
branch           at least once; a parent is declared before its children
event            declared after its owning branch
checkpoint       declared after the event it captures
```

Records of different kinds may otherwise interleave. Order is significant only
in that a record may not reference something the file has not declared yet.

## `session`

```json
{
  "type": "session",
  "schemaVersion": 1,
  "id": "s_01H...",
  "source": "chronos-jsonl",
  "createdAt": "2026-08-09T00:00:00Z"
}
```

| Field       | Type   | Notes                                           |
| ----------- | ------ | ----------------------------------------------- |
| `id`        | string | Non-empty; unique within the importing store    |
| `source`    | string | Adapter-defined label, not a provider resume id |
| `createdAt` | string | RFC 3339 timestamp                              |

## `branch`

```json
{ "type": "branch", "schemaVersion": 1, "id": "b_root" }
{ "type": "branch", "schemaVersion": 1, "id": "b_fix", "parentId": "b_root", "forkSeq": 4 }
```

A file declares exactly one root branch (no `parentId`, no `forkSeq`). A child
declares both fields, and `forkSeq` is a 1-based coordinate that must already
be visible in the parent. Imported branches are always `ready`: `preparing` and
`failed` describe branches Chronos is building, which never appear in a file.

## `event`

```json
{
  "type": "event",
  "schemaVersion": 1,
  "id": "e_0001",
  "branchId": "b_root",
  "seq": 1,
  "kind": "instruction",
  "occurredAt": "2026-08-09T00:00:00Z",
  "summary": "Add a retry to the upload client",
  "payload": { "text": "Add a retry to the upload client" },
  "raw": {
    "ref": "raw/e_0001.json",
    "mediaType": "application/json",
    "sourceSchemaVersion": "vendor-2"
  }
}
```

| Field        | Type   | Notes                                                   |
| ------------ | ------ | ------------------------------------------------------- |
| `branchId`   | string | Must name a declared branch                             |
| `seq`        | number | 1-based; the root starts at 1, a child at `forkSeq + 1` |
| `kind`       | string | One of the protocol event kinds                         |
| `occurredAt` | string | RFC 3339 timestamp                                      |
| `summary`    | string | Short display line; may be empty                        |
| `payload`    | JSON   | Normalized canonical data, wrapped on import            |
| `raw`        | object | Optional; see below                                     |

A branch owns a contiguous run of sequences. Payloads are plain JSON values:
no `undefined`, no cycles, no class instances.

`kind` values: `instruction`, `assistant_message`, `tool_call`, `tool_result`,
`filesystem_change`, `checkpoint`, `system`, `error`.

Recorded `tool_call` payloads are display data. Chronos never runs an imported
command, and branching from an event never replays one.

### `raw`

`raw` points at provider data held outside canonical storage. Raw retention is
off by default: unless an import explicitly opts in, `raw` is dropped and the
import reports a diagnostic saying so. When retention is enabled the reference
is kept, and the referenced bytes belong in a separate encrypted store.

## `checkpoint`

```json
{
  "type": "checkpoint",
  "schemaVersion": 1,
  "id": "cp_0002",
  "branchId": "b_root",
  "eventSeq": 2,
  "manifestRef": "sha256:1f0c..."
}
```

A checkpoint names the snapshot manifest capturing the filesystem state after
the event at `eventSeq`. One checkpoint per `(branchId, eventSeq)`. Events with
no checkpoint that deltas can reach are shown as non-branchable rather than
silently restored from the wrong state.

## Rejections

Import fails, rather than importing part of a file, when a record is malformed:
an unknown `type` or `schemaVersion`, a missing or duplicated `session` record,
more than one root branch, a reference to an undeclared branch, a
non-monotonic or non-contiguous `seq`, a duplicate id, a payload that is not
JSON, or a line larger than the configured limit. Dropping records silently
would make a transcript look complete when it is not.

## Example

```jsonl
{"type":"session","schemaVersion":1,"id":"s_demo","source":"chronos-jsonl","createdAt":"2026-08-09T00:00:00Z"}
{"type":"branch","schemaVersion":1,"id":"b_root"}
{"type":"event","schemaVersion":1,"id":"e1","branchId":"b_root","seq":1,"kind":"instruction","occurredAt":"2026-08-09T00:00:00Z","summary":"Fix the flaky upload test","payload":{"text":"Fix the flaky upload test"}}
{"type":"event","schemaVersion":1,"id":"e2","branchId":"b_root","seq":2,"kind":"filesystem_change","occurredAt":"2026-08-09T00:00:05Z","summary":"Wrote src/upload.ts","payload":{"paths":["src/upload.ts"]}}
{"type":"checkpoint","schemaVersion":1,"id":"cp2","branchId":"b_root","eventSeq":2,"manifestRef":"sha256:1f0c"}
```
