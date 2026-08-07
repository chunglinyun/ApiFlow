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

Three kinds, distinguished by `kind`. Shared fields:

| Field | Notes |
|---|---|
| `id` | unique string, e.g. `"n3"`. Wires reference it. |
| `kind` | `"request"` (default), `"transform"`, or `"json"` |
| `title` | display name |
| `x`, `y` | canvas position in px |
| `width` | optional, clamped 260–820 px |
| `disabled` | `true` = skipped by **Run all** (still runnable on its own via the node's ▶) |
| `inputs` | array of pins `{ id, name, value }` |
| `outputs` | array of pins `{ id, name, path? }` |

`pinId`s must be unique across the whole graph (wires reference `nodeId`+`pinId`).

### `kind: "request"`

| Field | Notes |
|---|---|
| `method` | `GET`/`POST`/`PUT`/`PATCH`/`DELETE`/`HEAD` |
| `path` | appended to `baseUrl`; may contain `{{name}}` tokens anywhere (incl. mid-path, e.g. `/userinfo/{{userId}}/profile`) resolved from wires entering the node |
| `headers` | `[{ id, key, value }]` |
| `fields` | body key/value editor: `[{ id, key, value, str? }]`, or a nested object `{ id, key, kind: "object", fields: [...] }` (recurses; in a form body a nested object is sent JSON-stringified) |
| `body` | raw body string (used for non-JSON/form content types) |
| `outputs` | each output's `path` is a dot-path into the JSON **response** (e.g. `data.token`), or prefixed `req.` to read what was **sent** (e.g. `req.client_reference`, `req.$path`, `req.$url`, `req.$body`) |

**JSON field typing.** In a JSON body a value is auto-typed — `"12"` is sent as the number `12`, and a field whose value is *exactly* the wire token keeps the upstream native type (object/number). Set `"str": true` on the field to force a JSON string (account numbers, ids with leading zeros). Form and raw bodies are always text, so `str` is ignored there.

**Two pin ids you don't declare in `inputs`:**

- **Path pin** — node id plus `:path` (node `"n2"` → pin `"n2:path"`). Wire an upstream output into it, then reference the wire's `{{name}}` in the path string.
- **Flow-in pin** — node id plus `__flow` (node `"n2"` → pin `"n2__flow"`). A pure sequencing edge: it injects no value, it only makes this node run after the upstream one. Typically fed by a `delay` node.

### `kind: "json"`

A JSON payload builder that sends nothing — it exists so a whole object can be signed
or encrypted. Same `fields` editor and typing rules as a JSON request body (nested
`kind:"object"`, `str`, wires into field values), `headers: []`, `inputs: []`, and
**two fixed outputs** so the shape is explicit:

| Output pin `name` | Value |
|---|---|
| `json` | the native object — wire into another node's JSON body field and it stays an object/number |
| `text` | `JSON.stringify(obj)` — the exact string a transform will hash/encrypt |

```json
{ "id": "n5", "kind": "json", "title": "Payload", "headers": [], "inputs": [],
  "fields": [{ "id": "f1", "key": "amount", "value": "1000" },
             { "id": "f2", "key": "account", "value": "0912345678", "str": true }],
  "outputs": [{ "id": "p10", "name": "json" }, { "id": "p11", "name": "text" }],
  "x": 60, "y": 60 }
```

Wire `text` → an `aes-cbc-encrypt` / `rsa-sha256-sign` transform to process the whole
payload. (Wiring `json` into a transform gives the same bytes — a transform coerces an
object input with `JSON.stringify` — but `text` says what you mean.) Key order in the
string is the field order in the editor; if the upstream API signs a canonical
ordering, order the fields to match.

### `kind: "transform"`

| Field | Notes |
|---|---|
| `algo` | one of the algorithm keys below |
| `key` | secret / PEM key (HMAC, AES, RSA); for `delay` it holds the **seconds to wait** |
| `iv` | AES IV (16 bytes after decoding) |
| `keyEnc` | how `key` is decoded: `"utf8"` (default) or `"base64"` (base64-encoded binary keys) |
| `ivEnc` | same for `iv`; **defaults to `keyEnc`**. Set it when an API mixes them (base64 32-byte key + plain 16-char IV) |
| `outEncoding` | `"hex"` (default) or `"base64"` — output encoding for hash/HMAC/encrypt, **input** ciphertext encoding for every `*-decrypt` algo |
| `inputs` | single pin `in`; `value` is a literal or `{{ref}}` used when no wire is connected |
| `outputs` | single pin `out` |

Algorithm keys: `base64-encode`, `base64-decode`, `md5`, `sha1`, `sha256`, `sha512`,
`hmac-sha256`, `aes-cbc-encrypt`, `aes-cbc-decrypt`, `rsa-sha256-sign`, `rsa-oaep-encrypt`,
`rsa-oaep-decrypt`, `delay`.

RSA keys are PEM (`pkcs8` private / `spki` public). Note the encrypt algos emit
base64 while `outEncoding` defaults to `hex`, so a decrypt node fed by one must be
switched to `"base64"` explicitly. There is no PKCS#1 v1.5 decrypt — the browser Web
Crypto API doesn't support it.

**How the input value is resolved** (matters when you want a prefix/suffix):

- no wire → the literal `value`, with generators resolved;
- wired **and** the literal contains that wire's `{{name}}` → substitution, so `"{{ref}}::2026-07-16"` works;
- wired and the literal doesn't mention it → the wired value **replaces** the literal.

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
- A wire into the **flow-in pin** carries no value at all — ordering only.
- One output pin may fan out to multiple inputs.

## Run semantics

**▶ Run all** topologically sorts nodes by wire dependencies and fires them in order
via the server-side `POST /proxy` forwarder. `disabled` nodes are skipped. Cycles
abort the run. The banner reports `Done — N node(s) OK` / `Done — M of N failed`.

**▶ on a node header** runs that node alone. Upstream nodes are **not** re-run —
wired values come from whatever their last run left in `outputValues` (never run →
blank). Use it to retry one failed call; use Run all when upstream values must be
fresh (expired token, new id).

Generators (`{{$guid}}`, `{{$uuid}}`, `{{$now}}`, `{{$timestamp}}`, `{{$date}}`,
`{{$time}}`, `{{$randomInt}}`) resolve fresh on **every occurrence**, every run — two
nodes that must share one generated id will get different values. Bake a literal, or
generate it in one node's body and wire that node's `req.<field>` output into the other.

## Reading results

Results are **not** persisted — Run all leaves them in memory only. `app.js` is a
classic script, so from the page's main world `nodes`, `wires`, `runAll()`,
`runOne(node)`, `toCurl(node)`, `renderAll()` and `save()` are top-level globals:

```js
nodes.map(n => ({ title: n.title, status: n.result?.status, err: n.result?.error,
                  body: n.result?.body, out: n.outputValues }))
```

From an isolated world (e.g. some browser-automation tools) those bindings aren't
visible — fall back to `document.querySelector('.node[data-node="<id>"]').innerText`.
Each node also has a **cURL** button (the exact composed request) and a **⧉ Copy**
button on its result bar.

## Image preview

If a node's output string is a base64 image (`data:image/…` URI or raw
PNG/JPEG/GIF/WebP base64), a **🖼 Image / 🖼 Text** toggle appears in its result bar.
The `<img>` is `width:100%`, so the node's resize handle scales it proportionally.

## DOM hooks (only if you must touch the live page)

- Nodes: `.node[data-node="<id>"]`; pins: `.pin[data-node][data-pin]`. A node carries
  `ok` / `err` / `running` / `disabled` classes reflecting its state.
- The `nodes` / `wires` globals can be replaced directly, then `renderAll(); save();`
  — but prefer Import over poking these.
