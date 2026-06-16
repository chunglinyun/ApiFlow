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

/* ---- Node presets shown in the palette ---------------------------------- */
const JSON_HEADER = [{ key: "Content-Type", value: "application/json" }];
const PRESETS = {
  blank: {
    title: "New request", method: "GET", path: "/",
    headers: JSON_HEADER, body: "", inputs: [], outputs: [],
  },
  qris: {
    title: "Generate QRIS", method: "POST", path: "/api/blazzpay/qris",
    headers: JSON_HEADER,
    body: pretty({ transactionId: "", username: "", amount: "" }),
    inputs: [],
    outputs: [{ name: "clientReference", path: "clientReference" }],
  },
  status: {
    title: "Check Status", method: "POST", path: "/api/blazzpay/qris/status",
    headers: JSON_HEADER,
    body: pretty({ transactionId: "", clientReference: "{{ref}}" }),
    inputs: [{ name: "ref", value: "" }],
    outputs: [{ name: "status", path: "status" }],
  },
  balance: {
    title: "Get Balance", method: "GET", path: "/api/blazzpay/balance",
    headers: [], body: "",
    inputs: [],
    outputs: [{ name: "balance", path: "balance" }],
  },
  notify: {
    title: "Payment Notification", method: "POST", path: "/api/blazzpay/notifications/payment",
    headers: [{ key: "Content-Type", value: "application/json" }, { key: "Authorization", value: "Basic " }],
    body: pretty({ transactionId: "", clientReference: "", amount: "", transDateTime: "", RRN: "", signatureCode: "" }),
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
    id: uid("n"),
    title: p.title, method: p.method, path: p.path,
    headers: p.headers.map((h) => ({ ...h })),
    body: p.body,
    form: (p.form || []).map((f) => ({ ...f })),
    inputs: p.inputs.map((i) => ({ id: uid("p"), name: i.name, value: i.value || "" })),
    outputs: p.outputs.map((o) => ({ id: uid("p"), name: o.name, path: o.path })),
    x, y,
    result: null,
    parsedBody: null,
    outputValues: {},
    inputResolved: {},
  };
}

function addNode(presetKey) {
  const wrap = els.canvasWrap;
  const x = wrap.scrollLeft + 70 + (spawnCount % 5) * 26;
  const y = wrap.scrollTop + 70 + (spawnCount % 5) * 26;
  spawnCount++;
  nodes.push(makeNode(presetKey, x, y));
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
  root.style.left = node.x + "px";
  root.style.top = node.y + "px";
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

  /* Body */
  const body = el("div", { class: "node-body" });

  const method = el("select", {
    class: "method-select",
    onchange: (e) => { node.method = e.target.value; save(); },
  }, METHODS.map((m) => el("option", { value: m, ...(m === node.method ? { selected: "selected" } : {}) }, m)));
  const path = el("input", {
    class: "path-input", spellcheck: "false", placeholder: "/path",
    value: node.path, oninput: (e) => { node.path = e.target.value; scheduleSave(); },
  });
  body.appendChild(el("div", { class: "row" }, [method, path]));

  /* Headers */
  body.appendChild(buildHeadersSection(node));

  /* Body (skip the editor for bodyless verbs) */
  if (node.method !== "GET" && node.method !== "HEAD") {
    body.appendChild(isFormNode(node) ? buildFormBody(node) : buildJsonBody(node));
  }

  /* Input + output pins */
  body.appendChild(buildInputsSection(node));
  body.appendChild(buildOutputsSection(node));

  /* Result */
  if (node.result) body.appendChild(buildResult(node));

  root.appendChild(body);
  return root;
}

function buildHeadersSection(node) {
  const list = el("div");
  node.headers.forEach((hdr, i) => {
    const isCt = hdr.key.trim().toLowerCase() === "content-type";
    const valueCell = isCt
      ? buildContentTypeValue(hdr)
      : el("input", { placeholder: "Value", value: hdr.value, spellcheck: "false",
          oninput: (e) => { hdr.value = e.target.value; scheduleSave(); } });
    list.appendChild(el("div", { class: "kv-row" }, [
      el("input", { class: "k", placeholder: "Header", value: hdr.key, spellcheck: "false",
        oninput: (e) => { hdr.key = e.target.value; scheduleSave(); },
        onchange: (e) => { if (e.target.value.trim().toLowerCase() === "content-type") { renderAll(); save(); } } }),
      valueCell,
      el("button", { class: "del-row", title: "Remove header", text: "×",
        onclick: () => { node.headers.splice(i, 1); renderAll(); save(); } }),
    ]));
  });
  return el("div", { class: "section" }, [
    el("div", { class: "section-title" }, [
      "Headers",
      el("button", { class: "mini-btn", text: "+ header",
        onclick: () => { node.headers.push({ key: "", value: "" }); renderAll(); save(); } }),
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

function buildJsonBody(node) {
  const ta = el("textarea", {
    class: "body-input", spellcheck: "false", placeholder: "request body (JSON)",
    oninput: (e) => { node.body = e.target.value; scheduleSave(); },
  });
  ta.value = node.body || "";
  return el("div", { class: "section" }, [el("div", { class: "section-title" }, ["Body"]), ta]);
}

function buildFormBody(node) {
  node.form = node.form || [];
  const list = el("div");
  node.form.forEach((f, i) => {
    list.appendChild(el("div", { class: "kv-row" }, [
      el("input", { class: "k", placeholder: "field", value: f.key, spellcheck: "false",
        oninput: (e) => { f.key = e.target.value; scheduleSave(); } }),
      el("input", { placeholder: "value", value: f.value, spellcheck: "false",
        oninput: (e) => { f.value = e.target.value; scheduleSave(); } }),
      el("button", { class: "del-row", title: "Remove field", text: "×",
        onclick: () => { node.form.splice(i, 1); renderAll(); save(); } }),
    ]));
  });
  return el("div", { class: "section" }, [
    el("div", { class: "section-title" }, [
      "Body (form-urlencoded)",
      el("button", { class: "mini-btn", text: "+ field",
        onclick: () => { node.form.push({ key: "", value: "" }); renderAll(); save(); } }),
    ]),
    list,
  ]);
}

function buildInputsSection(node) {
  const list = el("div");
  node.inputs.forEach((pin, i) => {
    const dot = el("span", { class: "pin in", "data-node": node.id, "data-pin": pin.id });
    const incoming = wires.find((w) => w.to.nodeId === node.id && w.to.pinId === pin.id);
    if (incoming) {
      dot.title = "Click to disconnect this wire";
      dot.addEventListener("click", () => {
        wires = wires.filter((w) => w.id !== incoming.id);
        renderAll();
        save();
      });
    }
    const resolved = node.inputResolved[pin.id];
    const row = el("div", { class: "pin-row input" }, [
      dot,
      el("input", { class: "pin-name", placeholder: "name", value: pin.name, spellcheck: "false",
        oninput: (e) => { pin.name = e.target.value; scheduleSave(); } }),
      el("input", { class: "pin-extra", placeholder: "default value", value: pin.value, spellcheck: "false",
        oninput: (e) => { pin.value = e.target.value; scheduleSave(); } }),
      (resolved !== undefined && resolved !== "")
        ? el("span", { class: "pin-resolved", title: String(resolved) }, ["= " + String(resolved)]) : null,
      el("button", { class: "del-row", title: "Remove input", text: "×",
        onclick: () => { removePin(node, "inputs", pin.id); } }),
    ]);
    list.appendChild(row);
  });
  return el("div", { class: "section" }, [
    el("div", { class: "section-title" }, [
      "Inputs  ⟨{{name}}⟩",
      el("button", { class: "mini-btn", text: "+ input",
        onclick: () => { node.inputs.push({ id: uid("p"), name: "", value: "" }); renderAll(); save(); } }),
    ]),
    list,
  ]);
}

function buildOutputsSection(node) {
  const list = el("div");
  node.outputs.forEach((pin) => {
    const dot = el("span", { class: "pin out", "data-node": node.id, "data-pin": pin.id });
    dot.addEventListener("pointerdown", (e) => startWireDrag(e, node.id, pin.id));
    const val = node.outputValues[pin.id];
    const row = el("div", { class: "pin-row output" }, [
      el("input", { class: "pin-name", placeholder: "name", value: pin.name, spellcheck: "false",
        oninput: (e) => { pin.name = e.target.value; scheduleSave(); } }),
      el("input", { class: "pin-extra", placeholder: "response path", value: pin.path, spellcheck: "false",
        oninput: (e) => { pin.path = e.target.value; scheduleSave(); } }),
      (val !== undefined && val !== null)
        ? el("span", { class: "pin-resolved", title: String(val) }, ["= " + String(val)]) : null,
      el("button", { class: "del-row", title: "Remove output", text: "×",
        onclick: () => { removePin(node, "outputs", pin.id); } }),
      dot,
    ]);
    list.appendChild(row);
  });
  return el("div", { class: "section" }, [
    el("div", { class: "section-title" }, [
      "Outputs  ⟨response path⟩",
      el("button", { class: "mini-btn", text: "+ output",
        onclick: () => { node.outputs.push({ id: uid("p"), name: "", path: "" }); renderAll(); save(); } }),
    ]),
    list,
  ]);
}

function buildResult(node) {
  const r = node.result;
  const meta = el("div", { class: "result-meta" });
  if (r.running) {
    meta.appendChild(el("span", { class: "badge" }, ["running…"]));
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
        wires.push({ id: uid("w"), from: { nodeId: fromNodeId, pinId: fromPinId }, to: { nodeId: toNodeId, pinId: toPinId } });
        drawWires();
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

async function runNode(node) {
  node.result = { running: true };
  node.outputValues = {};
  node.inputResolved = {};
  renderAll();

  const map = {};
  for (const inp of node.inputs) {
    const wire = wires.find((w) => w.to.nodeId === node.id && w.to.pinId === inp.id);
    let val = inp.value;
    if (wire) {
      const src = byId(wire.from.nodeId);
      val = src ? src.outputValues[wire.from.pinId] : undefined;
    }
    node.inputResolved[inp.id] = val;
    map[inp.name] = val;
  }

  const subst = (s) => substitute(s, map);
  const baseUrl = (els.baseUrl.value || "").trim().replace(/\/+$/, "");
  const rawPath = subst(node.path || "");
  const url = /^https?:\/\//i.test(rawPath) ? rawPath : baseUrl + (rawPath.startsWith("/") ? rawPath : "/" + rawPath);
  const headers = node.headers.filter((h) => h.key.trim()).map((h) => ({ key: subst(h.key), value: subst(h.value) }));

  let body = null;
  if (node.method !== "GET" && node.method !== "HEAD") {
    if (isFormNode(node)) {
      body = (node.form || [])
        .filter((f) => f.key.trim())
        .map((f) => encodeURIComponent(subst(f.key)) + "=" + encodeURIComponent(subst(f.value)))
        .join("&");
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
    await runNode(node);
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
let saveTimer = null;
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }
function save() {
  const data = {
    baseUrl: els.baseUrl.value,
    nodes: nodes.map((n) => ({
      id: n.id, title: n.title, method: n.method, path: n.path,
      headers: n.headers, body: n.body, form: n.form || [],
      inputs: n.inputs, outputs: n.outputs, x: n.x, y: n.y,
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
    nodes = (data.nodes || []).map((n) => ({ ...n, form: n.form || [], result: null, parsedBody: null, outputValues: {}, inputResolved: {} }));
    wires = data.wires || [];
    spawnCount = nodes.length;
    return true;
  } catch { return false; }
}

/* ---- Boot --------------------------------------------------------------- */
function init() {
  els.baseUrl = document.getElementById("baseUrl");
  els.runBtn = document.getElementById("runBtn");
  els.runStatus = document.getElementById("runStatus");
  els.clearBtn = document.getElementById("clearBtn");
  els.canvas = document.getElementById("canvas");
  els.canvasWrap = document.getElementById("canvasWrap");
  els.wireLayer = document.getElementById("wireLayer");
  els.emptyHint = document.getElementById("emptyHint");

  if (!load()) els.baseUrl.value = DEFAULT_BASE_URL;

  els.baseUrl.addEventListener("input", scheduleSave);
  els.runBtn.addEventListener("click", runAll);
  els.clearBtn.addEventListener("click", () => {
    if (!nodes.length || confirm("Remove all nodes and wires?")) {
      nodes = []; wires = []; spawnCount = 0; setStatus("", ""); renderAll(); save();
    }
  });
  document.querySelectorAll(".palette-item").forEach((btn) => {
    btn.addEventListener("click", () => addNode(btn.getAttribute("data-preset")));
  });

  // Remember the last focused value field so generators can target it.
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA") && t.closest && t.closest(".node")) {
      lastField = t;
    }
  });
  document.querySelectorAll(".gen-item").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => e.preventDefault()); // don't steal focus from the field
    btn.addEventListener("click", () => insertToken(btn.getAttribute("data-token")));
  });

  renderAll();
}

document.addEventListener("DOMContentLoaded", init);
