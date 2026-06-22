"use strict";

/* ApiFlow — a visual, drag-and-drop API workflow builder.
 *
 * Nodes are individual API requests (method + path + headers + body) sharing one global
 * Base URL. Wires drag an upstream node's OUTPUT pin (a JSON path into its response) into a
 * downstream node's INPUT pin; reference an input pin anywhere in the request with {{pinName}}.
 * "Run all" topologically sorts the graph and executes each node via the same-origin /proxy
 * forwarder, piping wired values along the way.
 */

const DEFAULT_BASE_URL = "http://localhost:5296";
const STORAGE_KEY = "apiflow.graph.v1";

/* ---- Node presets shown in the palette ----------------------------------
 * A request body is a list of key/value `fields`. At run time those fields are
 * serialized to JSON or x-www-form-urlencoded according to the Content-Type header
 * (other content types fall back to a raw text body). */
const JSON_HEADER = [{ key: "Content-Type", value: "application/json" }];
const PRESETS = {
  blank: {
    title: "New request", method: "GET", path: "/",
    headers: JSON_HEADER, fields: [], inputs: [], outputs: [],
  },
  qris: {
    title: "Generate QRIS", method: "POST", path: "/api/blazzpay/qris",
    headers: JSON_HEADER,
    fields: [{ key: "transactionId", value: "" }, { key: "username", value: "" }, { key: "amount", value: "" }],
    inputs: [],
    outputs: [{ name: "clientReference", path: "clientReference" }],
  },
  status: {
    title: "Check Status", method: "POST", path: "/api/blazzpay/qris/status",
    headers: JSON_HEADER,
    fields: [{ key: "transactionId", value: "" }, { key: "clientReference", value: "" }],
    inputs: [],
    outputs: [{ name: "status", path: "status" }],
  },
  balance: {
    title: "Get Balance", method: "GET", path: "/api/blazzpay/balance",
    headers: [], fields: [],
    inputs: [],
    outputs: [{ name: "balance", path: "balance" }],
  },
  notify: {
    title: "Payment Notification", method: "POST", path: "/api/blazzpay/notifications/payment",
    headers: [{ key: "Content-Type", value: "application/json" }, { key: "Authorization", value: "Basic " }],
    fields: [
      { key: "transactionId", value: "" }, { key: "clientReference", value: "" }, { key: "amount", value: "" },
      { key: "transDateTime", value: "" }, { key: "RRN", value: "" }, { key: "signatureCode", value: "" },
    ],
    inputs: [], outputs: [],
  },
};
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";
const CONTENT_TYPES = [
  "application/json",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
  "application/xml",
  "text/xml",
  "text/html",
  "application/octet-stream",
];

/* ---- Value generators (insertable via the palette, resolved at run time) - */
function uuidv4() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const GENERATORS = {
  $guid: () => uuidv4(),
  $uuid: () => uuidv4(),
  $now: () => new Date().toISOString(),
  $timestamp: () => String(Date.now()),
  $date: () => new Date().toISOString().slice(0, 10),
  $time: () => new Date().toTimeString().slice(0, 8),
  $randomInt: () => String(Math.floor(Math.random() * 1e9)),
};

/* Effective Content-Type for a node (lower-cased, without parameters). */
function contentTypeOf(node) {
  const h = node.headers.find((x) => x.key.trim().toLowerCase() === "content-type");
  return h ? h.value.split(";")[0].trim().toLowerCase() : "";
}
function isFormNode(node) { return contentTypeOf(node) === FORM_CONTENT_TYPE; }
// Empty/missing or application/json Content-Type → JSON body. Form/JSON both use the field editor.
function isJsonNode(node) { const ct = contentTypeOf(node); return ct === "" || ct === "application/json"; }
function isStructuredBody(node) { return isFormNode(node) || isJsonNode(node); }

// Coerce a string field value to a JSON value. Values stay STRINGS by default (so "100" or a
// long/leading-zero id is sent as a string, matching string-typed APIs); only true/false/null
// and explicit JSON objects/arrays ({…}/[…]) are parsed into their native types.
function coerceJsonValue(s) {
  if (typeof s !== "string") return s;
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if ((t[0] === "{" && t.endsWith("}")) || (t[0] === "[" && t.endsWith("]"))) { try { return JSON.parse(t); } catch { /* keep string */ } }
  return s;
}

/* ---- Transform (crypto) nodes ------------------------------------------- */
// Algorithms a transform node can run. `key` = shows a key/secret field;
// `iv` = shows an IV field; `enc` = offers a hex/base64 output-encoding choice.
const ALGORITHMS = {
  "base64-encode":   { label: "Base64 encode", key: false, enc: false },
  "base64-decode":   { label: "Base64 decode", key: false, enc: false },
  "md5":             { label: "MD5", key: false, enc: true },
  "sha1":            { label: "SHA-1", key: false, enc: true },
  "sha256":          { label: "SHA-256", key: false, enc: true },
  "sha512":          { label: "SHA-512", key: false, enc: true },
  "hmac-sha256":     { label: "HMAC-SHA256", key: true, enc: true },
  "aes-cbc-encrypt": { label: "AES-CBC encrypt", key: true, iv: true, enc: true },
  "aes-cbc-decrypt": { label: "AES-CBC decrypt", key: true, iv: true, enc: true },
  "rsa-sha256-sign": { label: "RSA-SHA256 sign (PEM private key)", key: true, enc: false },
  "rsa-oaep-encrypt":{ label: "RSA-OAEP encrypt (PEM public key)", key: true, enc: false },
};
// Palette items (dragged in like API clients); each seeds a default algorithm.
const TRANSFORM_PRESETS = {
  base64: { title: "Base64", algo: "base64-encode" },
  md5: { title: "MD5", algo: "md5" },
  sha: { title: "SHA-256", algo: "sha256" },
  hmac: { title: "HMAC", algo: "hmac-sha256" },
  aes: { title: "AES", algo: "aes-cbc-encrypt" },
  rsa: { title: "RSA", algo: "rsa-sha256-sign" },
};

/* Byte / encoding helpers */
function utf8Bytes(str) { return new TextEncoder().encode(str); }
function bytesToB64(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function encodeDigest(buf, enc) { return enc === "base64" ? bytesToB64(new Uint8Array(buf)) : bytesToHex(buf); }

/* Joseph Myers' MD5 (public domain), UTF-8 input, hex output. Web Crypto has no MD5. */
function md5(inputStr) {
  function add32(a, b) { return (a + b) & 0xffffffff; }
  function cmn(q, a, b, x, s, t) { a = add32(add32(a, q), add32(x, t)); return add32((a << s) | (a >>> (32 - s)), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }
  function md5cycle(x, k) {
    let [a, b, c, d] = x;
    a = ff(a, b, c, d, k[0], 7, -680876936); d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819); b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897); d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416); d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063); b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682); d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290); b = ff(b, c, d, a, k[15], 22, 1236535329);
    a = gg(a, b, c, d, k[1], 5, -165796510); d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713); b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691); d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438); d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961); b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473); b = gg(b, c, d, a, k[12], 20, -1926607734);
    a = hh(a, b, c, d, k[5], 4, -378558); d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060); d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632); b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174); d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979); b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487); d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520); b = hh(b, c, d, a, k[2], 23, -995338651);
    a = ii(a, b, c, d, k[0], 6, -198630844); d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905); b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571); d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523); b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359); d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070); d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259); b = ii(b, c, d, a, k[9], 21, -343485551);
    x[0] = add32(a, x[0]); x[1] = add32(b, x[1]); x[2] = add32(c, x[2]); x[3] = add32(d, x[3]);
  }
  function md5blk(s) {
    const blks = [];
    for (let i = 0; i < 64; i += 4) blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
    return blks;
  }
  function md51(s) {
    const n = s.length, state = [1732584193, -271733879, -1732584194, 271733878];
    let i;
    for (i = 64; i <= s.length; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
    s = s.substring(i - 64);
    const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
    tail[14] = n * 8;
    md5cycle(state, tail);
    return state;
  }
  function rhex(n) {
    let s = "";
    for (let j = 0; j < 4; j++) s += ((n >> (j * 8 + 4)) & 0x0f).toString(16) + ((n >> (j * 8)) & 0x0f).toString(16);
    return s;
  }
  const bytes = utf8Bytes(inputStr);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return md51(bin).map(rhex).join("");
}

function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
  if (!b64) throw new Error("Empty or invalid PEM key.");
  return b64ToBytes(b64).buffer;
}

// Apply a transform algorithm. Returns a string (hash/cipher text or decoded text).
async function applyAlgo(algo, input, key, enc, iv) {
  switch (algo) {
    case "base64-encode": return bytesToB64(utf8Bytes(input));
    case "base64-decode": return new TextDecoder().decode(b64ToBytes(input));
    case "md5": { const hex = md5(input); return enc === "base64" ? bytesToB64(hexToBytes(hex)) : hex; }
    case "sha1": return encodeDigest(await crypto.subtle.digest("SHA-1", utf8Bytes(input)), enc);
    case "sha256": return encodeDigest(await crypto.subtle.digest("SHA-256", utf8Bytes(input)), enc);
    case "sha512": return encodeDigest(await crypto.subtle.digest("SHA-512", utf8Bytes(input)), enc);
    case "hmac-sha256": {
      const k = await crypto.subtle.importKey("raw", utf8Bytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return encodeDigest(await crypto.subtle.sign("HMAC", k, utf8Bytes(input)), enc);
    }
    case "aes-cbc-encrypt": {
      const k = await crypto.subtle.importKey("raw", utf8Bytes(key), { name: "AES-CBC" }, false, ["encrypt"]);
      const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv: utf8Bytes(iv) }, k, utf8Bytes(input));
      return encodeDigest(ct, enc); // hex or base64
    }
    case "aes-cbc-decrypt": {
      const k = await crypto.subtle.importKey("raw", utf8Bytes(key), { name: "AES-CBC" }, false, ["decrypt"]);
      const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: utf8Bytes(iv) }, k, b64ToBytes(input));
      return new TextDecoder().decode(pt);
    }
    case "rsa-sha256-sign": {
      const k = await crypto.subtle.importKey("pkcs8", pemToDer(key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
      return bytesToB64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", k, utf8Bytes(input))));
    }
    case "rsa-oaep-encrypt": {
      const k = await crypto.subtle.importKey("spki", pemToDer(key), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      return bytesToB64(new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, k, utf8Bytes(input))));
    }
    default: throw new Error("Unknown algorithm: " + algo);
  }
}

/* ---- State -------------------------------------------------------------- */
let nodes = [];
let wires = [];
let idSeq = 0;
let spawnCount = 0;

const els = {};
let dragWire = null; // { fromNodeId, fromPinId, startX, startY }
let lastField = null; // most recently focused value field, for generator insertion

/* ---- Small helpers ------------------------------------------------------ */
function uid(prefix) { return prefix + Date.now().toString(36) + (idSeq++).toString(36); }
function pretty(obj) { return JSON.stringify(obj, null, 2); }
function byId(id) { return nodes.find((n) => n.id === id); }

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k === "value") node.value = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children || [])) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

/* ---- Node creation ------------------------------------------------------ */
function makeNode(presetKey, x, y) {
  const p = PRESETS[presetKey] || PRESETS.blank;
  return {
    id: uid("n"), kind: "request",
    title: p.title, method: p.method, path: p.path,
    headers: p.headers.map((h) => ({ id: uid("h"), key: h.key, value: h.value })),
    fields: (p.fields || []).map((f) => ({ id: uid("f"), key: f.key, value: f.value || "" })),
    body: "", // raw body, used only for non-JSON/non-form content types
    inputs: p.inputs.map((i) => ({ id: uid("p"), name: i.name, value: i.value || "" })),
    outputs: p.outputs.map((o) => ({ id: uid("p"), name: o.name, path: o.path })),
    x, y,
    result: null,
    parsedBody: null,
    outputValues: {},
    inputResolved: {},
  };
}

function makeTransformNode(presetKey, x, y) {
  const p = TRANSFORM_PRESETS[presetKey] || TRANSFORM_PRESETS.base64;
  return {
    id: uid("n"), kind: "transform",
    title: p.title, algo: p.algo, key: "", iv: "", outEncoding: "hex",
    inputs: [{ id: uid("p"), name: "in", value: "" }],
    outputs: [{ id: uid("p"), name: "out" }],
    x, y,
    result: null,
    parsedBody: null,
    outputValues: {},
    inputResolved: {},
  };
}

function spawnXY() {
  const wrap = els.canvasWrap;
  const x = wrap.scrollLeft + 70 + (spawnCount % 5) * 26;
  const y = wrap.scrollTop + 70 + (spawnCount % 5) * 26;
  spawnCount++;
  return { x, y };
}

function addNode(presetKey) {
  const { x, y } = spawnXY();
  nodes.push(makeNode(presetKey, x, y));
  renderAll();
  save();
}

function addTransform(presetKey) {
  const { x, y } = spawnXY();
  nodes.push(makeTransformNode(presetKey, x, y));
  renderAll();
  save();
}

/* ---- Rendering ---------------------------------------------------------- */
function renderAll() {
  // Wipe everything except the persistent SVG wire layer.
  Array.from(els.canvas.querySelectorAll(".node")).forEach((n) => n.remove());
  for (const node of nodes) els.canvas.appendChild(renderNode(node));
  els.emptyHint.style.display = nodes.length ? "none" : "block";
  drawWires();
}

function renderNode(node) {
  const root = el("div", { class: "node", "data-node": node.id });
  if (node.kind === "transform") root.classList.add("transform");
  root.style.left = node.x + "px";
  root.style.top = node.y + "px";
  if (node.width) root.style.width = node.width + "px";
  if (node.result) {
    if (node.result.running) root.classList.add("running");
    else if (node.result.error || node.result.status === 0 || node.result.status >= 400) root.classList.add("err");
    else root.classList.add("ok");
  }

  /* Header (drag handle) */
  const title = el("input", {
    class: "node-title", value: node.title,
    oninput: (e) => { node.title = e.target.value; scheduleSave(); },
  });
  const head = el("div", { class: "node-head" }, [
    title,
    el("button", { class: "node-del", title: "Delete node", text: "✕", onclick: () => deleteNode(node.id) }),
  ]);
  head.addEventListener("pointerdown", (e) => startNodeDrag(e, node, root));
  root.appendChild(head);

  /* Body container — request vs. transform layouts. */
  const body = el("div", { class: "node-body" });
  if (node.kind === "transform") buildTransformBody(node, body);
  else buildRequestBody(node, body);

  if (node.result) body.appendChild(buildResult(node));

  root.appendChild(body);

  // Drag handle (bottom-right) to resize the node's width.
  const rz = el("div", { class: "node-resize", title: "Drag to resize width" });
  rz.addEventListener("pointerdown", (e) => startNodeResize(e, node, root));
  root.appendChild(rz);

  return root;
}

function startNodeResize(e, node, root) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const startW = root.offsetWidth;
  function move(ev) {
    node.width = Math.max(260, Math.min(820, startW + (ev.clientX - startX)));
    root.style.width = node.width + "px";
    drawWires();
  }
  function up() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    save();
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

function buildRequestBody(node, body) {
  const method = el("select", {
    class: "method-select",
    onchange: (e) => { node.method = e.target.value; renderAll(); save(); },
  }, METHODS.map((m) => el("option", { value: m, ...(m === node.method ? { selected: "selected" } : {}) }, m)));
  const path = el("input", {
    class: "path-input", spellcheck: "false", placeholder: "/path",
    value: node.path, oninput: (e) => { node.path = e.target.value; scheduleSave(); },
  });
  body.appendChild(el("div", { class: "row" }, [method, path]));

  body.appendChild(buildHeadersSection(node));

  // Body editor — skipped for bodyless verbs. Field editor for JSON/form, raw text otherwise.
  if (node.method !== "GET" && node.method !== "HEAD") {
    body.appendChild(isStructuredBody(node) ? buildFieldsBody(node) : buildRawBody(node));
  }

  body.appendChild(buildOutputsSection(node));
}

// Small chip showing a wire's {{name}} token; click to insert it into the field value
// (so you can prefix it, e.g. type "Bearer " then click to get "Bearer {{accessToken}}").
function wireChipEl(item, incoming) {
  const token = "{{" + (incoming.name || "value") + "}}";
  const chip = el("span", { class: "wire-chip", title: "Click to insert " + token + " into the value" }, [token]);
  chip.addEventListener("mousedown", (e) => e.preventDefault());
  chip.addEventListener("click", () => { item.value = (item.value || "") + token; renderAll(); save(); });
  return chip;
}
function resolvedEl(val) {
  return (val !== undefined && val !== null && val !== "")
    ? el("span", { class: "pin-resolved", title: coerce(val) }, ["= " + coerce(val)]) : null;
}

function buildHeadersSection(node) {
  const list = el("div");
  node.headers.forEach((hdr, i) => {
    if (!hdr.id) hdr.id = uid("h");
    const isCt = hdr.key.trim().toLowerCase() === "content-type";
    const incoming = wires.find((w) => w.to.nodeId === node.id && w.to.pinId === hdr.id);
    // Header value can be supplied by a wire (output → header). The typed value is a fallback.
    const dot = el("span", { class: "pin in", "data-node": node.id, "data-pin": hdr.id });
    if (incoming) {
      dot.title = "Click to disconnect this wire";
      dot.addEventListener("click", () => { wires = wires.filter((w) => w.id !== incoming.id); renderAll(); save(); });
    }
    const valueCell = isCt
      ? buildContentTypeValue(hdr)
      : el("input", { placeholder: "Value", value: hdr.value, spellcheck: "false",
          oninput: (e) => { hdr.value = e.target.value; scheduleSave(); } });
    const wiredVal = incoming ? incomingValue(node.id, hdr.id) : undefined;
    list.appendChild(el("div", { class: "kv-row" }, [
      dot,
      el("input", { class: "k", placeholder: "Header", value: hdr.key, spellcheck: "false",
        oninput: (e) => { hdr.key = e.target.value; scheduleSave(); },
        onchange: (e) => { if (e.target.value.trim().toLowerCase() === "content-type") { renderAll(); save(); } } }),
      valueCell,
      (!isCt && incoming) ? wireChipEl(hdr, incoming) : null,
      resolvedEl(wiredVal),
      el("button", { class: "del-row", title: "Remove header", text: "×",
        onclick: () => { wires = wires.filter((w) => w.to.pinId !== hdr.id); node.headers.splice(i, 1); renderAll(); save(); } }),
    ]));
  });
  return el("div", { class: "section" }, [
    el("div", { class: "section-title" }, [
      "Headers  ⟨◉ wire-in⟩",
      el("button", { class: "mini-btn", text: "+ header",
        onclick: () => { node.headers.push({ id: uid("h"), key: "", value: "" }); renderAll(); save(); } }),
    ]),
    list,
  ]);
}

/* Content-Type value rendered as a real dropdown showing ALL options (a <datalist>
 * filters by the current text, so it would only show the matching entry). "Custom…" lets
 * the user type any other value (e.g. with a charset). Re-renders on change so the body
 * editor can switch between JSON and form-urlencoded modes. */
function buildContentTypeValue(hdr) {
  const known = CONTENT_TYPES.includes(hdr.value);
  const opts = [];
  if (!known) opts.push(el("option", { value: hdr.value, selected: "selected" }, hdr.value || "— select —"));
  for (const ct of CONTENT_TYPES) {
    opts.push(el("option", { value: ct, ...(ct === hdr.value ? { selected: "selected" } : {}) }, ct));
  }
  opts.push(el("option", { value: "__custom__" }, "Custom…"));
  return el("select", {
    class: "ct-select",
    onchange: (e) => {
      if (e.target.value === "__custom__") {
        const v = prompt("Enter a custom Content-Type:", hdr.value || "");
        if (v !== null && v.trim()) hdr.value = v.trim();
      } else {
        hdr.value = e.target.value;
      }
      renderAll();
      save();
    },
  }, opts);
}

// Field-based body. Each field is a key/value row with a left wire-in pin (like headers),
// serialized to JSON or form-urlencoded at run time based on Content-Type.
function buildFieldsBody(node) {
  node.fields = node.fields || [];
  const form = isFormNode(node);
  return el("div", { class: "section" }, [
    el("div", { class: "section-title" }, [
      form ? "Body fields  ⟨◉ → form-urlencoded⟩" : "Body fields  ⟨◉ → JSON⟩",
      el("button", { class: "mini-btn", text: "+ field",
        onclick: () => { node.fields.push({ id: uid("f"), key: "", value: "" }); renderAll(); save(); } }),
      el("button", { class: "mini-btn", text: "+ obj", title: "Add a nested object field",
        onclick: () => { node.fields.push({ id: uid("f"), key: "", kind: "object", fields: [] }); renderAll(); save(); } }),
    ]),
    buildFieldRows(node, node.fields),
  ]);
}

// Recursively render body-field rows. Object fields nest their own rows (and add buttons).
function buildFieldRows(node, fields) {
  const list = el("div");
  fields.forEach((f) => {
    if (!f.id) f.id = uid("f");
    if (f.kind === "object") {
      f.fields = f.fields || [];
      list.appendChild(el("div", { class: "kv-row obj-row" }, [
        el("span", { class: "obj-caret" }, ["{ }"]),
        el("input", { class: "k", placeholder: "object key", value: f.key, spellcheck: "false",
          oninput: (e) => { f.key = e.target.value; scheduleSave(); } }),
        el("button", { class: "mini-btn", text: "+ field",
          onclick: () => { f.fields.push({ id: uid("f"), key: "", value: "" }); renderAll(); save(); } }),
        el("button", { class: "mini-btn", text: "+ obj",
          onclick: () => { f.fields.push({ id: uid("f"), key: "", kind: "object", fields: [] }); renderAll(); save(); } }),
        el("button", { class: "del-row", title: "Remove object", text: "×",
          onclick: () => removeFieldDeep(node, f.id) }),
      ]));
      const nested = buildFieldRows(node, f.fields);
      nested.classList.add("field-nested");
      list.appendChild(nested);
    } else {
      const incoming = wires.find((w) => w.to.nodeId === node.id && w.to.pinId === f.id);
      const dot = el("span", { class: "pin in", "data-node": node.id, "data-pin": f.id });
      if (incoming) {
        dot.title = "Click to disconnect this wire";
        dot.addEventListener("click", () => { wires = wires.filter((w) => w.id !== incoming.id); renderAll(); save(); });
      }
      const shown = incoming ? incomingValue(node.id, f.id) : (node.fieldResolved ? node.fieldResolved[f.id] : undefined);
      list.appendChild(el("div", { class: "kv-row" }, [
        dot,
        el("input", { class: "k", placeholder: "field", value: f.key, spellcheck: "false",
          oninput: (e) => { f.key = e.target.value; scheduleSave(); } }),
        el("input", { placeholder: "value", value: f.value || "", spellcheck: "false",
          oninput: (e) => { f.value = e.target.value; scheduleSave(); } }),
        incoming ? wireChipEl(f, incoming) : null,
        resolvedEl(shown),
        el("button", { class: "del-row", title: "Remove field", text: "×",
          onclick: () => removeFieldDeep(node, f.id) }),
      ]));
    }
  });
  return list;
}

// Raw text body — used when Content-Type isn't JSON or form (text/plain, xml, octet-stream…).
function buildRawBody(node) {
  const ta = el("textarea", {
    class: "body-input", spellcheck: "false", placeholder: "raw request body",
    oninput: (e) => { node.body = e.target.value; scheduleSave(); },
  });
  ta.value = node.body || "";
  return el("div", { class: "section" }, [el("div", { class: "section-title" }, ["Body (raw)"]), ta]);
}

function buildOutputsSection(node) {
  const list = el("div");
  // After a run, offer the response's keys as a dropdown so the user picks exactly one.
  const paths = (node.parsedBody && typeof node.parsedBody === "object") ? flattenPaths(node.parsedBody) : [];
  node.outputs.forEach((pin) => {
    const dot = el("span", { class: "pin out", "data-node": node.id, "data-pin": pin.id });
    dot.addEventListener("pointerdown", (e) => startWireDrag(e, node.id, pin.id));
    const val = node.outputValues[pin.id];
    const picker = paths.length
      ? el("select", { class: "path-pick", title: "Pick a key from the last response",
          onchange: (e) => { if (e.target.value) { pin.path = e.target.value; renderAll(); save(); } } },
          [el("option", { value: "" }, "▾key")].concat(paths.map((p) => el("option", { value: p, ...(p === pin.path ? { selected: "selected" } : {}) }, p))))
      : null;
    const row = el("div", { class: "pin-row output" }, [
      el("input", { class: "pin-extra path-out", placeholder: "response path (e.g. data.token)", value: pin.path, spellcheck: "false",
        oninput: (e) => { pin.path = e.target.value; scheduleSave(); } }),
      picker,
      (val !== undefined && val !== null)
        ? el("span", { class: "pin-resolved", title: coerce(val) }, ["= " + coerce(val)]) : null,
      el("button", { class: "del-row", title: "Remove output", text: "×",
        onclick: () => { removePin(node, "outputs", pin.id); } }),
      dot,
    ]);
    list.appendChild(row);
  });
  return el("div", { class: "section" }, [
    el("div", { class: "section-title" }, [
      "Outputs  ⟨response path → {{key}}⟩",
      el("button", { class: "mini-btn", text: "+ output",
        onclick: () => { node.outputs.push({ id: uid("p"), path: "" }); renderAll(); save(); } }),
    ]),
    list,
  ]);
}

/* ---- Transform node body ------------------------------------------------ */
function buildTransformBody(node, body) {
  const meta = ALGORITHMS[node.algo] || ALGORITHMS["base64-encode"];

  const algoSel = el("select", {
    class: "algo-select",
    onchange: (e) => { node.algo = e.target.value; renderAll(); save(); },
  }, Object.keys(ALGORITHMS).map((a) => el("option", { value: a, ...(a === node.algo ? { selected: "selected" } : {}) }, ALGORITHMS[a].label)));
  body.appendChild(el("div", { class: "row" }, [algoSel]));

  // Single input pin (wire target) + literal/{{ref}} fallback.
  const inPin = node.inputs[0];
  const inDot = el("span", { class: "pin in", "data-node": node.id, "data-pin": inPin.id });
  const incoming = wires.find((w) => w.to.nodeId === node.id && w.to.pinId === inPin.id);
  if (incoming) {
    inDot.title = "Click to disconnect this wire";
    inDot.addEventListener("click", () => { wires = wires.filter((w) => w.id !== incoming.id); renderAll(); save(); });
  }
  const inResolved = node.inputResolved[inPin.id];
  body.appendChild(el("div", { class: "section" }, [
    el("div", { class: "section-title" }, ["Input  ⟨◉ wire-in⟩"]),
    el("div", { class: "pin-row input" }, [
      inDot,
      el("input", { class: "pin-extra", placeholder: incoming ? "(from wire)" : "text or {{ref}}", value: inPin.value, spellcheck: "false",
        oninput: (e) => { inPin.value = e.target.value; scheduleSave(); } }),
      (inResolved !== undefined && inResolved !== "")
        ? el("span", { class: "pin-resolved", title: String(inResolved) }, ["= " + String(inResolved)]) : null,
    ]),
  ]));

  // Key / secret (HMAC + RSA).
  if (meta.key) {
    const keyArea = el("textarea", {
      class: "body-input key-input", spellcheck: "false",
      placeholder: node.algo.startsWith("rsa") ? "-----BEGIN ... KEY-----" : "secret key",
      oninput: (e) => { node.key = e.target.value; scheduleSave(); },
    });
    keyArea.value = node.key || "";
    body.appendChild(el("div", { class: "section" }, [el("div", { class: "section-title" }, ["Key / secret"]), keyArea]));
  }

  // IV (AES). UTF-8 text; AES-CBC needs 16 bytes.
  if (meta.iv) {
    const ivInput = el("input", {
      class: "body-input", spellcheck: "false", placeholder: "16-byte IV",
      value: node.iv || "",
      oninput: (e) => { node.iv = e.target.value; scheduleSave(); },
    });
    body.appendChild(el("div", { class: "section" }, [el("div", { class: "section-title" }, ["IV"]), ivInput]));
  }

  // Output encoding (hash / HMAC / AES encrypt).
  if (meta.enc) {
    const encSel = el("select", {
      class: "enc-select",
      onchange: (e) => { node.outEncoding = e.target.value; save(); },
    }, ["hex", "base64"].map((x) => el("option", { value: x, ...((node.outEncoding || "hex") === x ? { selected: "selected" } : {}) }, x)));
    body.appendChild(el("div", { class: "section" }, [el("div", { class: "section-title" }, ["Output encoding"]), encSel]));
  }

  // Single output pin.
  const outPin = node.outputs[0];
  const outDot = el("span", { class: "pin out", "data-node": node.id, "data-pin": outPin.id });
  outDot.addEventListener("pointerdown", (e) => startWireDrag(e, node.id, outPin.id));
  const outVal = node.outputValues[outPin.id];
  body.appendChild(el("div", { class: "section" }, [
    el("div", { class: "section-title" }, ["Output"]),
    el("div", { class: "pin-row output" }, [
      el("span", { class: "out-label" }, ["out"]),
      (outVal !== undefined && outVal !== null && outVal !== "")
        ? el("span", { class: "pin-resolved", title: String(outVal) }, ["= " + String(outVal)]) : null,
      outDot,
    ]),
  ]));
}

function buildResult(node) {
  const r = node.result;
  const meta = el("div", { class: "result-meta" });
  if (r.running) {
    meta.appendChild(el("span", { class: "badge" }, ["running…"]));
  } else if (r.transform) {
    meta.appendChild(el("span", { class: "badge " + (r.error ? "s0" : "s2") }, [r.error ? "error" : "done"]));
    if (typeof r.elapsedMs === "number") meta.appendChild(el("span", { class: "result-time" }, [r.elapsedMs + " ms"]));
  } else {
    const cls = r.status === 0 ? "s0" : "s" + String(r.status)[0];
    meta.appendChild(el("span", { class: "badge " + cls }, [String(r.status) + (r.reason ? " " + r.reason : "")]));
    if (typeof r.elapsedMs === "number") meta.appendChild(el("span", { class: "result-time" }, [r.elapsedMs + " ms"]));
  }
  let bodyText;
  if (r.error) bodyText = "⚠ " + r.error;
  else if (node.parsedBody !== null && node.parsedBody !== undefined) bodyText = pretty(node.parsedBody);
  else bodyText = r.body || "(empty response)";
  return el("div", { class: "result" }, [meta, el("pre", { class: "result-body" }, [bodyText])]);
}

function removePin(node, kind, pinId) {
  node[kind] = node[kind].filter((p) => p.id !== pinId);
  wires = wires.filter((w) => w.from.pinId !== pinId && w.to.pinId !== pinId);
  renderAll();
  save();
}

function deleteNode(id) {
  nodes = nodes.filter((n) => n.id !== id);
  wires = wires.filter((w) => w.from.nodeId !== id && w.to.nodeId !== id);
  renderAll();
  save();
}

/* ---- Wires (SVG) -------------------------------------------------------- */
function pinEl(nodeId, pinId, type) {
  return els.canvas.querySelector(`.pin.${type}[data-node="${nodeId}"][data-pin="${pinId}"]`);
}

function pinCenter(pinElement) {
  const r = pinElement.getBoundingClientRect();
  const c = els.canvas.getBoundingClientRect();
  return { x: r.left + r.width / 2 - c.left, y: r.top + r.height / 2 - c.top };
}

function wirePath(x1, y1, x2, y2) {
  const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function drawWires() {
  const svg = els.wireLayer;
  svg.innerHTML = "";
  for (const w of wires) {
    const from = pinEl(w.from.nodeId, w.from.pinId, "out");
    const to = pinEl(w.to.nodeId, w.to.pinId, "in");
    if (!from || !to) continue;
    const a = pinCenter(from);
    const b = pinCenter(to);
    const d = wirePath(a.x, a.y, b.x, b.y);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
    group.setAttribute("class", "wire-group");
    const hit = mkPath(d, "wire-hit");
    hit.addEventListener("click", () => { wires = wires.filter((x) => x.id !== w.id); drawWires(); save(); });
    hit.style.cursor = "pointer";
    group.appendChild(hit);
    group.appendChild(mkPath(d, "wire"));
    svg.appendChild(group);
    pinEl(w.to.nodeId, w.to.pinId, "in").classList.add("linked");
  }
}

function mkPath(d, cls) {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  p.setAttribute("class", cls);
  return p;
}

/* ---- Dragging a node ---------------------------------------------------- */
function startNodeDrag(e, node, root) {
  if (e.target.closest(".node-title, .node-del")) return; // let inputs/buttons work
  e.preventDefault();
  root.style.zIndex = 10;
  const startX = e.clientX, startY = e.clientY;
  const origX = node.x, origY = node.y;
  function move(ev) {
    node.x = Math.max(0, origX + (ev.clientX - startX));
    node.y = Math.max(0, origY + (ev.clientY - startY));
    root.style.left = node.x + "px";
    root.style.top = node.y + "px";
    drawWires();
  }
  function up() {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    root.style.zIndex = "";
    save();
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

// A wire's variable name (used as {{name}}) is the last segment of the source output's
// response path (e.g. "json.accessToken" → "accessToken"); transform outputs fall back to "out".
function deriveWireName(fromNodeId, fromPinId) {
  const src = byId(fromNodeId);
  const pin = src && (src.outputs || []).find((o) => o.id === fromPinId);
  let raw = "value";
  if (pin) {
    if (pin.path) {
      const segs = String(pin.path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
      if (segs.length) raw = segs[segs.length - 1];
    } else if (pin.name) {
      raw = pin.name;
    }
  }
  return raw.replace(/[^\w$]/g, "") || "value";
}
// Ensure the name is unique among wires already entering the target node.
function uniqueWireName(toNodeId, base) {
  const taken = new Set(wires.filter((w) => w.to.nodeId === toNodeId).map((w) => w.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + i)) i++;
  return base + i;
}
// Give any wire loaded/imported without a name one (derived from its upstream output).
function backfillWireNames() {
  for (const w of wires) {
    if (!w.name) w.name = uniqueWireName(w.to.nodeId, deriveWireName(w.from.nodeId, w.from.pinId));
  }
}

/* ---- Dragging a wire ---------------------------------------------------- */
function startWireDrag(e, fromNodeId, fromPinId) {
  e.preventDefault();
  e.stopPropagation();
  const from = pinEl(fromNodeId, fromPinId, "out");
  const start = pinCenter(from);
  dragWire = { fromNodeId, fromPinId };

  const temp = mkPath("", "wire-temp");
  els.wireLayer.appendChild(temp);

  function move(ev) {
    const c = els.canvas.getBoundingClientRect();
    const x = ev.clientX - c.left, y = ev.clientY - c.top;
    temp.setAttribute("d", wirePath(start.x, start.y, x, y));
  }
  function up(ev) {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    temp.remove();
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    if (target && target.classList.contains("pin") && target.classList.contains("in")) {
      const toNodeId = target.getAttribute("data-node");
      const toPinId = target.getAttribute("data-pin");
      if (toNodeId !== fromNodeId) {
        // An input pin accepts a single incoming wire — replace any existing one.
        wires = wires.filter((w) => !(w.to.nodeId === toNodeId && w.to.pinId === toPinId));
        const name = uniqueWireName(toNodeId, deriveWireName(fromNodeId, fromPinId));
        wires.push({ id: uid("w"), name, from: { nodeId: fromNodeId, pinId: fromPinId }, to: { nodeId: toNodeId, pinId: toPinId } });
        drawWires();
        renderAll();
        save();
      }
    }
    dragWire = null;
  }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
}

/* ---- Run engine --------------------------------------------------------- */
function topoSort() {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const w of wires) {
    if (w.from.nodeId === w.to.nodeId) continue;
    adj.get(w.from.nodeId).push(w.to.nodeId);
    indeg.set(w.to.nodeId, indeg.get(w.to.nodeId) + 1);
  }
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const m of adj.get(id)) {
      indeg.set(m, indeg.get(m) - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  if (order.length !== nodes.length) throw new Error("Cycle detected in wiring — cannot run.");
  return order;
}

function getPath(obj, path) {
  if (!path) return obj;
  const tokens = String(path).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[t];
  }
  return cur;
}

function substitute(str, map) {
  return String(str).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (m, name) => {
    // Generators (e.g. {{$guid}}) produce a fresh value on every occurrence.
    if (name[0] === "$" && GENERATORS[name]) return GENERATORS[name]();
    if (!(name in map)) return m;
    const v = map[name];
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

function coerce(v) { return v === undefined || v === null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v)); }

// Value flowing into (nodeId, pinId) from a connected upstream output, or undefined.
function incomingValue(nodeId, pinId) {
  const w = wires.find((x) => x.to.nodeId === nodeId && x.to.pinId === pinId);
  if (!w) return undefined;
  const src = byId(w.from.nodeId);
  return src ? src.outputValues[w.from.pinId] : undefined;
}
function hasIncoming(nodeId, pinId) {
  return wires.some((x) => x.to.nodeId === nodeId && x.to.pinId === pinId);
}
function incomingWire(nodeId, pinId) { return wires.find((x) => x.to.nodeId === nodeId && x.to.pinId === pinId); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Build { wireName: upstreamValue } for every wire entering a node, for {{name}} substitution.
function wireMapFor(node) {
  const map = {};
  for (const w of wires) {
    if (w.to.nodeId !== node.id) continue;
    const src = byId(w.from.nodeId);
    map[w.name || "value"] = src ? src.outputValues[w.from.pinId] : undefined;
  }
  return map;
}

// Resolve a header/field value to a string. Substitute {{names}}; if the field is wired but the
// wire's {{name}} isn't referenced, append the wired value (keeps a typed prefix like "Bearer ").
function resolveTemplate(node, item, map) {
  const out = substitute(item.value || "", map);
  const w = incomingWire(node.id, item.id);
  if (!w) return out;
  const name = w.name || "value";
  if (new RegExp("\\{\\{\\s*" + escapeRe(name) + "\\s*\\}\\}").test(item.value || "")) return out;
  return out + coerce(map[name]);
}

// JSON variant: when the whole value is exactly the wire token (or empty + wired), return the
// native value so objects/numbers keep their type; otherwise substitute + coerce like above.
function resolveTemplateJson(node, item, map) {
  const w = incomingWire(node.id, item.id);
  if (w) {
    const name = w.name || "value";
    const v = (item.value || "").trim();
    if (v === "" || new RegExp("^\\{\\{\\s*" + escapeRe(name) + "\\s*\\}\\}$").test(v)) return map[name];
    if (!new RegExp("\\{\\{\\s*" + escapeRe(name) + "\\s*\\}\\}").test(v)) return coerceJsonValue(substitute(v, map) + coerce(map[name]));
  }
  return coerceJsonValue(substitute(item.value || "", map));
}

// Serialize body fields (incl. nested object fields) into a JSON object.
function fieldsToJsonObject(node, fields, map) {
  const obj = {};
  for (const f of fields || []) {
    if (!f.key || !f.key.trim()) continue;
    if (f.kind === "object") {
      obj[substitute(f.key, map)] = fieldsToJsonObject(node, f.fields || [], map);
    } else {
      const v = resolveTemplateJson(node, f, map);
      if (node.fieldResolved) node.fieldResolved[f.id] = v;
      obj[substitute(f.key, map)] = v;
    }
  }
  return obj;
}

// Flatten an object's reachable dot/index paths — powers the output key picker.
function flattenPaths(obj, prefix, out, depth) {
  out = out || []; depth = depth || 0;
  if (obj === null || typeof obj !== "object" || depth > 4) return out;
  if (Array.isArray(obj)) { if (obj.length) flattenPaths(obj[0], (prefix || "") + "[0]", out, depth + 1); return out; }
  for (const k of Object.keys(obj)) {
    const p = prefix ? prefix + "." + k : k;
    out.push(p);
    if (obj[k] && typeof obj[k] === "object") flattenPaths(obj[k], p, out, depth + 1);
  }
  return out;
}

// Remove a (possibly nested) body field by id, plus any wires targeting it or its descendants.
function removeFieldDeep(node, id) {
  let removed = null;
  const rec = (arr) => {
    const i = arr.findIndex((f) => f.id === id);
    if (i >= 0) { removed = arr.splice(i, 1)[0]; return true; }
    for (const f of arr) if (f.kind === "object" && f.fields && rec(f.fields)) return true;
    return false;
  };
  rec(node.fields || []);
  const ids = new Set();
  (function collect(f) { if (!f) return; ids.add(f.id); (f.fields || []).forEach(collect); })(removed);
  wires = wires.filter((w) => !ids.has(w.to.pinId));
  renderAll();
  save();
}

async function runNode(node) {
  node.result = { running: true };
  node.outputValues = {};
  node.inputResolved = {};
  renderAll();

  // Substitution map = { wireName: upstreamValue } for every wire entering this node.
  const map = wireMapFor(node);
  node.fieldResolved = {};

  const subst = (s) => substitute(s, map);
  const baseUrl = (els.baseUrl.value || "").trim().replace(/\/+$/, "");
  const rawPath = subst(node.path || "");
  const url = /^https?:\/\//i.test(rawPath) ? rawPath : baseUrl + (rawPath.startsWith("/") ? rawPath : "/" + rawPath);
  const headers = node.headers.filter((h) => h.key.trim()).map((h) => ({
    key: subst(h.key),
    value: resolveTemplate(node, h, map),
  }));

  let body = null;
  if (node.method !== "GET" && node.method !== "HEAD") {
    if (isFormNode(node)) {
      const flat = [];
      (function walk(fields) {
        for (const f of fields || []) {
          if (!f.key.trim()) continue;
          if (f.kind === "object") flat.push([f.key, JSON.stringify(fieldsToJsonObject(node, f.fields || [], map))]);
          else { const v = resolveTemplate(node, f, map); node.fieldResolved[f.id] = v; flat.push([f.key, v]); }
        }
      })(node.fields);
      body = flat.map(([k, v]) => encodeURIComponent(subst(k)) + "=" + encodeURIComponent(v)).join("&");
    } else if (isJsonNode(node)) {
      body = JSON.stringify(fieldsToJsonObject(node, node.fields || [], map));
    } else {
      body = subst(node.body || "");
    }
  }

  try {
    const resp = await fetch("/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: node.method, url, headers, body }),
    });
    const data = await resp.json();
    node.result = { status: data.status, reason: data.reasonPhrase, elapsedMs: data.elapsedMs, body: data.body, error: data.error };
    let parsed = null;
    try { parsed = data.body ? JSON.parse(data.body) : null; } catch { parsed = null; }
    node.parsedBody = parsed;
    for (const out of node.outputs) {
      node.outputValues[out.id] = parsed !== null ? getPath(parsed, out.path) : undefined;
    }
  } catch (err) {
    node.result = { status: 0, error: err.message };
    node.parsedBody = null;
  }
}

async function runTransform(node) {
  node.result = { running: true, transform: true };
  node.outputValues = {};
  node.inputResolved = {};
  renderAll();

  const inPin = node.inputs[0];
  // Wired input overrides the literal; literals still allow generators like {{$guid}}.
  const input = hasIncoming(node.id, inPin.id)
    ? coerce(incomingValue(node.id, inPin.id))
    : substitute(inPin.value || "", {});
  node.inputResolved[inPin.id] = input;
  const key = substitute(node.key || "", {});
  const iv = substitute(node.iv || "", {});

  const t0 = performance.now();
  try {
    const out = await applyAlgo(node.algo, input, key, node.outEncoding || "hex", iv);
    node.result = { transform: true, body: out, elapsedMs: Math.round(performance.now() - t0) };
    node.outputValues[node.outputs[0].id] = out;
  } catch (err) {
    node.result = { transform: true, error: err.message, elapsedMs: Math.round(performance.now() - t0) };
  }
}

async function runAll() {
  if (!nodes.length) return;
  let order;
  try {
    order = topoSort();
  } catch (err) {
    setStatus(err.message, "err");
    return;
  }
  els.runBtn.disabled = true;
  setStatus("Running…", "");
  for (const n of nodes) { n.result = null; n.outputValues = {}; n.inputResolved = {}; n.parsedBody = null; }
  renderAll();

  let failures = 0;
  for (const id of order) {
    const node = byId(id);
    if (node.kind === "transform") await runTransform(node);
    else await runNode(node);
    if (node.result.error || node.result.status === 0 || node.result.status >= 400) failures++;
    renderAll();
  }
  els.runBtn.disabled = false;
  setStatus(
    failures ? `Done — ${failures} of ${order.length} failed` : `Done — ${order.length} node(s) OK`,
    failures ? "err" : "ok");
}

function setStatus(text, cls) {
  els.runStatus.textContent = text;
  els.runStatus.className = "run-status" + (cls ? " " + cls : "");
}

/* ---- Generator insertion ------------------------------------------------ */
function insertToken(token) {
  const f = lastField;
  if (!f || !document.body.contains(f)) {
    setStatus("Click a value field first, then a generator.", "err");
    return;
  }
  const start = f.selectionStart ?? f.value.length;
  const end = f.selectionEnd ?? f.value.length;
  f.value = f.value.slice(0, start) + token + f.value.slice(end);
  const pos = start + token.length;
  f.setSelectionRange(pos, pos);
  f.focus();
  f.dispatchEvent(new Event("input", { bubbles: true })); // sync the bound model + save
}

/* ---- Persistence -------------------------------------------------------- */
// Migrate a saved node to the field-based body model: prefer existing `fields`, then the old
// `form` array, then parse a legacy JSON `body` string into fields.
function normalizeFields(arr) {
  return (arr || []).map((f) => (f.kind === "object"
    ? { id: f.id || uid("f"), key: f.key, kind: "object", fields: normalizeFields(f.fields) }
    : { id: f.id || uid("f"), key: f.key, value: f.value }));
}
function migrateFields(n) {
  if (Array.isArray(n.fields)) return normalizeFields(n.fields);
  if (Array.isArray(n.form)) return n.form.map((f) => ({ id: uid("f"), key: f.key, value: f.value }));
  try {
    const o = JSON.parse(n.body);
    if (o && typeof o === "object" && !Array.isArray(o)) {
      return Object.entries(o).map(([k, v]) => ({ id: uid("f"), key: k, value: typeof v === "object" ? JSON.stringify(v) : String(v) }));
    }
  } catch { /* not JSON — leave as raw body */ }
  return [];
}

let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
function save() {
  const data = {
    baseUrl: els.baseUrl.value,
    nodes: nodes.map((n) => ({
      id: n.id, kind: n.kind || "request", title: n.title,
      method: n.method, path: n.path, headers: n.headers, fields: n.fields || [], body: n.body || "",
      algo: n.algo, key: n.key, outEncoding: n.outEncoding,
      inputs: n.inputs, outputs: n.outputs, x: n.x, y: n.y, width: n.width,
    })),
    wires,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* ignore quota */ }
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    els.baseUrl.value = data.baseUrl || DEFAULT_BASE_URL;
    nodes = (data.nodes || []).map((n) => ({
      ...n,
      kind: n.kind || "request",
      fields: migrateFields(n),
      body: typeof n.body === "string" ? n.body : "",
      headers: (n.headers || []).map((h) => ({ id: h.id || uid("h"), key: h.key, value: h.value })),
      result: null, parsedBody: null, outputValues: {}, inputResolved: {},
    }));
    wires = data.wires || [];
    backfillWireNames();
    spawnCount = nodes.length;
    return true;
  } catch { return false; }
}

/* ---- Export/Import ------------------------------------------------------- */
function exportWorkflow() {
  const data = {
    version: "1.0",
    exportedAt: new Date().toISOString(),
    baseUrl: els.baseUrl.value,
    nodes: nodes.map((n) => ({
      id: n.id, kind: n.kind || "request", title: n.title,
      method: n.method, path: n.path, headers: n.headers, fields: n.fields || [], body: n.body || "",
      algo: n.algo, key: n.key, outEncoding: n.outEncoding,
      inputs: n.inputs, outputs: n.outputs, x: n.x, y: n.y, width: n.width,
    })),
    wires,
  };

  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `apiflow-workflow-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function validateWorkflowData(data) {
  if (!data || typeof data !== "object") return false;
  if (!Array.isArray(data.nodes) || !Array.isArray(data.wires)) return false;
  if (typeof data.baseUrl !== "string") return false;
  return true;
}

function importWorkflow(file) {
  if (!file) return;
  if (!file.name.endsWith(".json")) {
    setStatus("Invalid file: must be .json", "err");
    return;
  }
  
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!validateWorkflowData(data)) {
        setStatus("Invalid workflow format", "err");
        return;
      }
      
      if (nodes.length > 0 && !confirm("This will replace your current workflow. Continue?")) {
        return;
      }
      
      els.baseUrl.value = data.baseUrl || DEFAULT_BASE_URL;
      nodes = (data.nodes || []).map((n) => ({
        ...n,
        kind: n.kind || "request",
        fields: migrateFields(n),
        body: typeof n.body === "string" ? n.body : "",
        headers: (n.headers || []).map((h) => ({ id: h.id || uid("h"), key: h.key, value: h.value })),
        result: null, parsedBody: null, outputValues: {}, inputResolved: {},
      }));
      wires = data.wires || [];
      backfillWireNames();
      spawnCount = Math.max(spawnCount, nodes.length);
      setStatus("Workflow imported successfully", "ok");
      renderAll();
      save();
    } catch (err) {
      setStatus("Error importing workflow: " + err.message, "err");
    }
  };
  reader.onerror = () => {
    setStatus("Error reading file", "err");
  };
  reader.readAsText(file);
}

/* ---- Boot --------------------------------------------------------------- */
function init() {
  els.baseUrl = document.getElementById("baseUrl");
  els.runBtn = document.getElementById("runBtn");
  els.runStatus = document.getElementById("runStatus");
  els.exportBtn = document.getElementById("exportBtn");
  els.importBtn = document.getElementById("importBtn");
  els.importFile = document.getElementById("importFile");
  els.clearBtn = document.getElementById("clearBtn");
  els.canvas = document.getElementById("canvas");
  els.canvasWrap = document.getElementById("canvasWrap");
  els.wireLayer = document.getElementById("wireLayer");
  els.emptyHint = document.getElementById("emptyHint");

  if (!load()) els.baseUrl.value = DEFAULT_BASE_URL;

  els.baseUrl.addEventListener("input", scheduleSave);
  els.runBtn.addEventListener("click", runAll);
  els.exportBtn.addEventListener("click", exportWorkflow);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (e) => importWorkflow(e.target.files[0]));
  els.clearBtn.addEventListener("click", () => {
    if (!nodes.length || confirm("Remove all nodes and wires?")) {
      nodes = []; wires = []; spawnCount = 0; setStatus("", ""); renderAll(); save();
    }
  });
  // Only request presets (transform buttons share .palette-item for styling but have no data-preset).
  document.querySelectorAll(".palette-item[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => addNode(btn.getAttribute("data-preset")));
  });
  document.querySelectorAll(".transform-item").forEach((btn) => {
    btn.addEventListener("click", () => addTransform(btn.getAttribute("data-transform")));
  });

  // Remember the last focused value field so generators can target it; redraw wires since a
  // focused input grows to a full-width line (shifting pin positions).
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && t.closest && t.closest(".node")) {
      lastField = t;
      if (t.tagName === "INPUT") t.classList.add("growing");
      drawWires();
    }
  });
  document.addEventListener("focusout", (e) => {
    const t = e.target;
    if (t && t.closest && t.closest(".node")) {
      t.classList.remove("growing");
      drawWires();
    }
  });
  document.querySelectorAll(".gen-item").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // don't steal focus from the field
    btn.addEventListener("click", () => insertToken(btn.getAttribute("data-token")));
  });

  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
