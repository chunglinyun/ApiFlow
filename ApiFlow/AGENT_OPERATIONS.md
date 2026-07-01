# ApiFlow — Agent Operations Guide

How to operate / programmatically drive the ApiFlow canvas. The [README](README.md)
covers concepts for a human at the browser; this file covers the data model and the
reliable way for an agent to build or modify a workflow **without simulating mouse drags**.

## Preferred path: edit the JSON, then Import

Don't emulate drag-and-drop. The whole canvas is one JSON object. Build/modify that
object and load it via the **⬆ Import** button (or write it straight into
`localStorage` under key `apiflow.graph.v1` and reload the page).

Export/Import file shape:

```json
{
  "version": "1.0",
  "exportedAt": "<ISO timestamp>",
  "baseUrl": "http://localhost:5296",
  "nodes": [ /* Node objects */ ],
  "wires": [ /* Wire objects */ ]
}
```

`localStorage` uses the same shape minus `version`/`exportedAt`.

## Node object

Two kinds, distinguished by `kind`. Shared fields:

| Field | Notes |
|---|---|
| `id` | unique string, e.g. `"n3"`. Wires reference it. |
| `kind` | `"request"` (default) or `"transform"` |
| `title` | display name |
| `x`, `y` | canvas position in px |
| `width` | optional, clamped 260–820 px |
| `inputs` | array of pins `{ id, name, value }` |
| `outputs` | array of pins `{ id, name, path? }` |

`pinId`s must be unique across the whole graph (wires reference `nodeId`+`pinId`).

### `kind: "request"`

| Field | Notes |
|---|---|
| `method` | `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD` |
| `path` | appended to `baseUrl`; may contain `{{name}}` tokens anywhere (incl. mid-path, e.g. `/userinfo/{{userId}}/profile`) resolved from wires entering the node |
| `headers` | `[{ id, key, value }]` |
| `fields` | body key/value editor: `[{ id, key, value }]` |
| `body` | raw body string (used for non-JSON/form content types) |
| `outputs` | each output's `path` is a dot-path into the JSON **response** (e.g. `data.token`), or prefixed `req.` to read what was **sent** (e.g. `req.client_reference`, `req.$path`, `req.$url`, `req.$body`) |

The path is also a wire target: its pin id is the node id plus `:path` (e.g. node `"n2"` → pin `"n2:path"`). Wire an upstream output into it, then reference the wire's `{{name}}` in the path string.

### `kind: "transform"`

| Field | Notes |
|---|---|
| `algo` | one of the algorithm keys below |
| `key` | secret / PEM key (HMAC, AES, RSA) |
| `iv` | AES IV (16 bytes after decoding) |
| `keyEnc` | AES Key/IV encoding: `"utf8"` (default) or `"base64"` (for base64-encoded binary keys, e.g. BlazzPay) |
| `outEncoding` | `"hex"` or `"base64"` (hash/HMAC/AES output; AES-decrypt input encoding) |
| `inputs` | single pin `in`; `value` is a literal or `{{ref}}` used when no wire is connected |
| `outputs` | single pin `out` |

Algorithm keys: `base64-encode`, `base64-decode`, `md5`, `sha1`, `sha256`, `sha512`,
`hmac-sha256`, `aes-cbc-encrypt`, `aes-cbc-decrypt`, `rsa-sha256-sign`, `rsa-oaep-encrypt`.

## Wire object

```json
{
  "id": "w1",
  "name": "accessToken",
  "from": { "nodeId": "n1", "pinId": "<output pinId>" },
  "to":   { "nodeId": "n2", "pinId": "<input pinId>" }
}
```

- A wire into a **header/body-field** value *appends* the upstream value to whatever
  literal text is already in that field.
- A wire into a **transform input** replaces the literal.
- A wire into the **path pin** doesn't append; place the `{{name}}` token yourself
  anywhere in the path string (the run engine substitutes it).
- One output pin may fan out to multiple inputs.

## Run semantics

**▶ Run all** topologically sorts nodes by wire dependencies and fires them in order
via the server-side `POST /proxy` forwarder. Generators (`{{$guid}}`, `{{$now}}`,
`{{$timestamp}}`, `{{$date}}`, `{{$time}}`, `{{$randomInt}}`) resolve fresh per run.
Cycles abort the run.

## Image preview

If a node's output string is a base64 image (`data:image/…` URI or raw
PNG/JPEG/GIF/WebP base64), a **🖼 Image / 🖼 Text** toggle appears in its result bar.
The `<img>` is `width:100%`, so the node's resize handle scales it proportionally.

## DOM hooks (only if you must touch the live page)

- Nodes: `.node[data-node="<id>"]`; pins: `.pin[data-node][data-pin]`.
- Global state lives in `nodes` / `wires` arrays in `app.js`; `renderAll()` redraws,
  `save()` persists. Prefer Import over poking these.
