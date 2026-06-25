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
| AES | AES-CBC encrypt/decrypt with a custom key + IV (Key/IV as UTF-8 text or base64-encoded binary; key 16/24/32 bytes, IV 16 bytes) — hex or base64 output |
| RSA | RSA-SHA256 sign (PEM private key), RSA-OAEP encrypt (PEM public key) |

All crypto runs in the browser via the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (except MD5, which has a built-in implementation).

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

Field values are sent as **strings** by default. The exceptions are `true`, `false`, `null`, and values that are valid JSON objects or arrays (`{…}` / `[…]`), which are coerced to their native types.

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
