# ApiFlow

A visual, drag-and-drop API workflow builder for local development. Build multi-step API call sequences with wired data flow — no code required.

## Overview

ApiFlow lets you compose API requests as nodes on a canvas and connect them with wires so the output of one request flows automatically into the input of the next. A server-side proxy handles CORS, so you can call any endpoint without browser restrictions.

```
[Generate QRIS] --clientReference--> [Check Status] --status--> [Transform: HMAC]
```

## Getting Started

```bash
# From the solution root
dotnet run --project ApiFlow
```

Then open `http://localhost:5296` in your browser (or whichever port is shown in the console).

## Architecture

| Layer | File | Responsibility |
|---|---|---|
| UI | `wwwroot/index.html`, `app.js`, `styles.css` | Canvas, node rendering, wiring, run engine |
| Proxy | `Program.cs` — `POST /proxy` | Server-side forwarder that bypasses CORS; returns upstream status/headers/body as data |

> ⚠️ The `/proxy` endpoint is an unauthenticated open forwarder. It is intended for **local development only** — do not expose it on a public network.

## Concepts

### Nodes

Each node represents a single API request:

- **Method** — GET, POST, PUT, PATCH, DELETE, HEAD
- **Path** — appended to the shared Base URL in the top bar
- **Headers** — key/value pairs; add as many as needed
- **Body** — key/value field editor for `application/json` and `application/x-www-form-urlencoded`; raw text box for other content types
- **Outputs** — named JSON paths into the response body that can be wired to downstream nodes

Nodes can be freely dragged, resized, renamed, and deleted.

### JSON Payload Nodes

**{ } JSON payload** (palette, top) builds a JSON object from the same field editor as a request body, but sends nothing. Use it when a whole payload has to be signed or encrypted before it goes anywhere. It has two output pins:

- **json** — the object itself. Wired into another node's JSON body field it stays an object (numbers stay numbers).
- **text** — `{"key":"value",…}` as a string. Wire this into an AES / RSA / HMAC transform to process the entire payload.

The key order in **text** is the field order in the editor — reorder the fields if the API signs a specific ordering.

When a node's output is a base64 image (a `data:image/…` URI or raw PNG/JPEG/GIF/WebP base64), a **🖼 Image / 🖼 Text** toggle appears in the result bar. The preview scales to the node's width — drag the bottom-right resize handle to grow it proportionally.

### Wires

Drag from a node's right **●** output pin to another node's left **●** input pin to pipe a value.

- A wire on a **header or body-field** value appends the upstream value to whatever text you typed (e.g. type `Bearer ` then wire an `accessToken` output → `Bearer <token>`).
- For precise placement, use the `{{pinName}}` chip — click the chip in the palette to insert the token at the cursor position in any value field.
- Wires are removed by clicking the wire line or clicking the connected input pin.

### Outputs & Response Paths

Add an output on a node and give it a **response path** (dot-notation into the JSON response, e.g. `data.token`). After a successful run, use the **▾** dropdown to pick a key from the parsed response instead of typing the path manually. One output can feed multiple targets.

### Transform Nodes

Transform nodes apply a crypto or encoding operation before passing a value along. Drag one in from the palette sidebar.

| Transform | Algorithms |
|---|---|
| Base64 | encode, decode |
| MD5 | hex or base64 output |
| SHA | SHA-1, SHA-256, SHA-512 — hex or base64 |
| HMAC | HMAC-SHA256 with a secret key — hex or base64 |
| AES | AES-CBC encrypt/decrypt with a custom key + IV (key and IV each have their own UTF-8 / base64 selector; key must decode to 16/24/32 bytes, IV to 16) — hex or base64 output |
| RSA | RSA-SHA256 sign (PEM private key), RSA-OAEP encrypt (PEM public key), RSA-OAEP decrypt (PEM private key, hex or base64 input) |

All crypto runs in the browser via the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (except MD5, Base64 and Delay, which need no crypto).

⚠ **Web Crypto only exists in a secure context.** Served from a plain-HTTP LAN address (e.g. `http://10.20.26.158:8098`) or from `file://`, `crypto.subtle` is undefined and every SHA / HMAC / AES / RSA node fails. Open ApiFlow over `https://`, or via `http://localhost:<port>`, or allow the origin in `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

### Value Generators

Click a value field to focus it, then click a generator button in the sidebar to insert a token. Tokens are resolved fresh on every **Run**.

| Token | Resolves to |
|---|---|
| `{{$guid}}` | Random UUID v4 |
| `{{$now}}` | Current datetime (ISO 8601) |
| `{{$timestamp}}` | Current Unix timestamp (ms) |
| `{{$date}}` | Current date (`YYYY-MM-DD`) |
| `{{$time}}` | Current time (`HH:MM:SS`) |
| `{{$randomInt}}` | Random integer (0–999999999) |

### Body Serialisation

| Content-Type | Body format |
|---|---|
| `application/json` (default) | Field editor → serialised to a JSON object |
| `application/x-www-form-urlencoded` | Field editor → serialised to a form-encoded string |
| anything else | Raw text box |

In a JSON body, field values are auto-typed: `true` / `false` / `null`, numbers (up to 15 digits), and valid JSON objects or arrays (`{…}` / `[…]`) are sent as their native types; everything else is a string. A field wired straight from an upstream output keeps that value's original type. Click the **str** button on a field to force it to a string — needed for numeric-looking values that must stay text (account numbers, ids with leading zeros).

Use the **+ obj** button to nest an object inside a field (e.g. `amount → { value, currency }`).

## Running a Workflow

1. Set the **Base URL** in the top bar (default: `http://localhost:5296`).
2. Add nodes and wire them together.
3. Click **▶ Run all**.

Nodes execute in topological (dependency) order. Wired values are resolved and injected before each node fires. Each node shows its HTTP status and response inline after the run.

## Import / Export

- **⬇ Export** — downloads the current canvas as a `.json` file.
- **⬆ Import** — loads a previously exported `.json` file, replacing the current canvas.

The canvas is also **auto-saved to `localStorage`** (`apiflow.graph.v1`) and restored on next load.

## Configuration

No extra configuration is needed. The proxy is self-contained in `Program.cs` and the UI is served from `wwwroot` as static files.

The only external dependency is [`Api.Common`](../Api.Common) (for request logging middleware).
