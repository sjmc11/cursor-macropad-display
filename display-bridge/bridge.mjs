#!/usr/bin/env node
// Cursor -> desk display bridge.
//
// Cursor hooks (see install.mjs) forward each hook payload to this daemon on
// 127.0.0.1. The daemon keeps per-conversation state, works out what the
// display should show, and POSTs it to the clock (debounced, plus a heartbeat
// so the display knows the Mac is alive).
//
// No dependencies. Config: display-bridge/config.json (see config.example.json).
//   node display-bridge/bridge.mjs            run in the foreground
//   curl 127.0.0.1:47321/state                what it would send right now

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = {
  device: "http://192.168.0.89",
  port: 47321,
  heartbeatSeconds: 30,
  turnTimeoutMinutes: 10, // a turn with no events for this long counts as finished
  defaultContextWindow: 200000,
  logEvents: true, // metadata only (no prompt/response text) -> ~/.cursor-display/events.jsonl
  ...readJson(path.join(HERE, "config.json")),
};
const DATA_DIR = path.join(os.homedir(), ".cursor-display");
fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG = path.join(DATA_DIR, "events.jsonl");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------------ state --

/** @type {Map<string, any>} */
const convs = new Map();
const tokensToday = { day: today(), byConv: new Map() };
let selected = null; // updated immediately by the macropad extension
let windowRoot = null; // workspace of the focused Cursor window, from the macropad extension

// Survive restarts (re-install, login) without waiting for the next hook.
// Metadata only: ids, model, params, status, paths.
const STATE_FILE = path.join(DATA_DIR, "state.json");
{
  const saved = readJson(STATE_FILE);
  windowRoot = saved.windowRoot || null;
  selected = saved.selected || null;
  for (const c of saved.convs || []) if (c?.id) convs.set(c.id, c);
}

function saveState() {
  const value = { windowRoot, selected, convs: [...convs.values()] };
  fs.writeFile(STATE_FILE, JSON.stringify(value), () => {});
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ------------------------------------------------- Cursor's context usage --
// Cursor stores the figures behind its "Context Usage" popup per conversation
// in composerData:<id>. Read-only; only the numeric fields are used.

const CURSOR_DB = path.join(
  os.homedir(),
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
);
// Order is part of the display contract (ctx_parts); matches Cursor's popup.
const CTX_CATEGORIES = [
  "system_prompt",
  "tools",
  "rules",
  "skills",
  "mcp",
  "subagents",
  "summarized_conversation",
  "conversation",
];
let cursorDb = null;
const cursorCtxCache = new Map();

// ------------------------------------------------------------ git branch --
// Reads HEAD directly (no git process); handles worktrees and subfolders.

const branchCache = new Map();

function gitBranch(root) {
  if (!root) return "";
  const hit = branchCache.get(root);
  if (hit && Date.now() - hit.at < 1500) return hit.value;
  let value = "";
  try {
    for (let dir = root; ; dir = path.dirname(dir)) {
      const dotgit = path.join(dir, ".git");
      if (fs.existsSync(dotgit)) {
        let gitdir = dotgit;
        if (fs.statSync(dotgit).isFile()) {
          const m = fs.readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)$/m);
          if (m) gitdir = path.resolve(dir, m[1].trim());
        }
        const head = fs.readFileSync(path.join(gitdir, "HEAD"), "utf8").trim();
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        value = ref ? ref[1] : head.slice(0, 7);
        break;
      }
      if (path.dirname(dir) === dir) break;
    }
  } catch {
    value = "";
  }
  branchCache.set(root, { at: Date.now(), value });
  return value;
}

// While an agent runs, show its project; otherwise the focused window's.
function workspaceInfo(focus, anyActive) {
  const root = anyActive
    ? focus?.root || windowRoot
    : windowRoot || focus?.root;
  return { project: root ? path.basename(root) : "", branch: gitBranch(root) };
}

function cursorContext(convId) {
  const hit = cursorCtxCache.get(convId);
  if (hit && Date.now() - hit.at < 2000) return hit.value;
  let value = null;
  try {
    cursorDb ??= new DatabaseSync(CURSOR_DB, { readOnly: true });
    const row = cursorDb
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${convId}`);
    if (row?.value) {
      const d = JSON.parse(row.value);
      value = {};
      if (d.contextTokensUsed > 0 && d.contextTokenLimit > 0) {
        const byId = new Map(
          (d.promptTokenBreakdown?.categories || []).map((c) => [
            c.id,
            Math.round(c.estimatedTokens || 0),
          ]),
        );
        value.used = d.contextTokensUsed;
        value.max = d.contextTokenLimit;
        value.parts = CTX_CATEGORIES.map((id) => byId.get(id) || 0);
      }
      // The model picker's selection for this conversation. Hooks are less
      // reliable: each thought event arrives twice with different models.
      const sel = d.modelConfig?.selectedModels?.[0];
      const model = sel?.modelId || d.modelConfig?.modelName;
      if (model) {
        value.model = model;
        value.params = paramsToObject(sel?.parameters);
      }
    }
  } catch {
    cursorDb?.close();
    cursorDb = null;
  }
  cursorCtxCache.set(convId, { at: Date.now(), value });
  return value;
}

function conv(id) {
  if (!convs.has(id)) {
    convs.set(id, {
      id,
      model: "",
      params: {},
      mode: "",
      active: false,
      status: "idle",
      msg: "",
      last: Date.now(),
      subagents: 0,
      ctx: null,
      transcript: null,
    });
  }
  return convs.get(id);
}

function paramsToObject(p) {
  const o = {};
  if (Array.isArray(p)) {
    for (const x of p) if (x && x.id != null) o[x.id] = x.value;
  } else if (p && typeof p === "object") {
    Object.assign(o, p);
  }
  return o;
}

function parseWindow(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const m = String(v)
    .trim()
    .match(/^([\d.]+)\s*([kKmM]?)/);
  if (!m) return null;
  const n =
    parseFloat(m[1]) *
    (m[2].toLowerCase() === "m" ? 1e6 : m[2].toLowerCase() === "k" ? 1e3 : 1);
  return n >= 1000 ? Math.round(n) : null;
}

function base(file) {
  return file ? path.basename(String(file)) : "";
}

function describeTool(e) {
  const name = e.tool_name || "";
  const input = e.tool_input || {};
  if (e.hook_event_name === "afterFileEdit")
    return `Edited ${base(e.file_path)}`;
  if (e.hook_event_name === "afterShellExecution")
    return `Ran ${String(e.command || "").split("\n")[0]}`;
  if (e.hook_event_name === "afterMCPExecution")
    return `${e.mcp_server_name || "MCP"}: ${name}`;
  const file =
    input.path || input.file_path || input.target_file || input.filePath;
  if (/read/i.test(name) && file) return `Read ${base(file)}`;
  if (/(edit|write|apply)/i.test(name) && file) return `Edited ${base(file)}`;
  if (
    /(shell|terminal|bash|command)/i.test(name) &&
    (input.command || input.cmd)
  )
    return `Ran ${String(input.command || input.cmd).split("\n")[0]}`;
  if (/(grep|search|glob|find)/i.test(name))
    return `Searching${input.pattern || input.query ? ": " + (input.pattern || input.query) : ""}`;
  return name ? `Tool: ${name}` : "";
}

// Rough context estimate from the transcript file (used until a preCompact
// event gives the exact figure). ~4 bytes per token of JSONL.
function estimateFromTranscript(c) {
  if (!c.transcript) return;
  try {
    const size = fs.statSync(c.transcript).size;
    const est = Math.round(size / 4);
    if (!c.ctx || !c.ctx.exact || c.ctx.at < Date.now() - 5 * 60e3) {
      c.ctx = {
        tokens: est,
        window: c.ctx?.window || null,
        exact: false,
        at: Date.now(),
      };
    }
    if (tokensToday.day !== today()) {
      tokensToday.day = today();
      tokensToday.byConv.clear();
    }
    tokensToday.byConv.set(
      c.id,
      Math.max(tokensToday.byConv.get(c.id) || 0, est),
    );
  } catch {
    /* transcript not there (yet) */
  }
}

function handle(e) {
  const ev = e.hook_event_name;
  if (!ev || ev === "workspaceOpen") return;
  const id = e.conversation_id || e.session_id;
  if (!id) return;
  const c = conv(id);
  c.last = Date.now();
  // Tool events carry a bare model id without params; only trust events that
  // include params, so the name and effort don't flip between event types.
  if (e.model_params) {
    c.params = paramsToObject(e.model_params);
    if (e.model) c.model = e.model;
  } else if (e.model && !c.model) {
    c.model = e.model;
  }
  if (e.transcript_path) c.transcript = e.transcript_path;
  if (Array.isArray(e.workspace_roots) && e.workspace_roots[0])
    c.root = e.workspace_roots[0];

  switch (ev) {
    case "sessionStart":
      if (e.composer_mode) c.mode = e.composer_mode;
      break;
    case "beforeSubmitPrompt":
      c.active = true;
      c.status = "thinking";
      c.msg = "";
      break;
    case "afterAgentThought":
      c.active = true;
      c.status = "thinking";
      break;
    case "postToolUse":
    case "afterFileEdit":
    case "afterShellExecution":
    case "afterMCPExecution":
      c.active = true;
      c.status = "working";
      c.msg = describeTool(e) || c.msg;
      break;
    case "postToolUseFailure":
      c.active = true;
      c.status = "working";
      c.msg = `Failed: ${e.tool_name || "tool"}`;
      break;
    case "afterAgentResponse":
      c.active = true;
      c.status = "working";
      c.msg = "Writing response";
      break;
    case "subagentStart":
      c.active = true;
      c.subagents++;
      c.status = "working";
      c.msg = `Subagent: ${e.subagent_type || e.task || ""}`.trim();
      break;
    case "subagentStop":
      c.subagents = Math.max(0, c.subagents - 1);
      break;
    case "preCompact":
      c.ctx = {
        tokens: e.context_tokens,
        window: e.context_window_size,
        exact: true,
        at: Date.now(),
      };
      c.msg = "Compacting context";
      break;
    case "stop":
      c.active = false;
      c.subagents = 0;
      c.status = e.status === "error" ? "error" : "idle";
      c.msg =
        e.status === "error"
          ? "Stopped with an error"
          : e.status === "aborted"
            ? "Stopped"
            : "Done";
      break;
    case "sessionEnd":
      convs.delete(id);
      schedulePush();
      return;
  }
  estimateFromTranscript(c);
  schedulePush();
}

function snapshot() {
  const now = Date.now();
  const timeout = CONFIG.turnTimeoutMinutes * 60e3;
  for (const c of convs.values()) {
    if (c.active && now - c.last > timeout) {
      c.active = false;
      c.status = "idle";
      c.subagents = 0;
    }
    if (!c.active && now - c.last > 24 * 3600e3) convs.delete(c.id);
  }
  const all = [...convs.values()].sort((a, b) => b.last - a.last);
  const active = all.filter((c) => c.active);
  const focus = active[0] || all[0];
  const agents = active.length + active.reduce((n, c) => n + c.subagents, 0);
  if (!focus) {
    const effort = effortLabel(selected?.params);
    return {
      state: "idle",
      model: prettyModel(selected?.model),
      effort,
      mode: "",
      msg: visibleStatus(effort, "", "No agent activity yet"),
      agents: 0,
      ctx_used: 0,
      ctx_max: 0,
      ctx_parts: [],
      tokens: 0,
      ...workspaceInfo(null, false),
    };
  }

  const exact = cursorContext(focus.id);
  // Model / effort: a fresh macropad selection (Cursor writes it to its DB a
  // moment later), then the conversation's picker selection, then hooks.
  const pick =
    selected && Date.now() - selected.at < 10e3
      ? selected
      : exact?.model
        ? exact
        : { model: focus.model, params: focus.params };
  const p = pick.params || {};
  const effort = effortLabel(p);
  const windowSize =
    exact?.max ||
    focus.ctx?.window ||
    parseWindow(p.context) ||
    CONFIG.defaultContextWindow;
  const ctxTokens = exact?.used || focus.ctx?.tokens || 0;
  let tokens = 0;
  for (const v of tokensToday.byConv.values()) tokens += v;

  let msg = focus.msg;
  if (!focus.active && active.length === 0 && focus.status === "idle")
    msg = focus.msg === "Done" ? `Done ${ago(focus.last)}` : msg;
  // Current display firmware draws msg instead of the effort field.
  const mode = focus.mode ? cap(focus.mode) : "";
  msg = visibleStatus(effort, mode, msg);

  return {
    state: focus.active
      ? focus.status
      : focus.status === "error"
        ? "error"
        : "idle",
    model: prettyModel(pick.model),
    effort,
    mode,
    msg,
    agents,
    ctx_used: ctxTokens,
    ctx_max: windowSize,
    ctx_parts: exact?.parts || [],
    tokens,
    ...workspaceInfo(focus, active.length > 0),
  };
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function effortLabel(p) {
  if (!p) return "";
  const level = p.effort ?? p.reasoning_effort ?? p.reasoning;
  if (level) return `${cap(String(level))} effort`;
  if (p.thinking === true || p.thinking === "true") return "Thinking";
  return "";
}

// The clock has one 47-character status line and currently prefers msg over effort.
function visibleStatus(effort, mode, activity) {
  const selected = [effort, mode].filter(Boolean).join(" · ");
  const detail = activity === "Context is an estimate" ? "" : activity || "";
  if (!selected) return detail;
  if (!detail) return selected;
  const combined = `${selected} · ${detail}`;
  if (combined.length <= 47) return combined;
  return `${selected} · ${detail.slice(0, Math.max(0, 44 - selected.length))}`;
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60
    ? "just now"
    : s < 3600
      ? `${Math.round(s / 60)} min ago`
      : `${Math.round(s / 3600)} h ago`;
}
function prettyModel(m) {
  const value = String(m || "").replace(/^models\//, "");
  return value === "default" ? "Auto" : value;
}

// ------------------------------------------------------------------- push --

let pushTimer = null;
let lastSent = "";
let lastSentAt = 0;

function schedulePush() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    push(false);
  }, 150);
}

async function push(force) {
  const body = JSON.stringify(snapshot());
  if (!force && body === lastSent) return;
  saveState();
  try {
    const res = await fetch(`${CONFIG.device}/state`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      lastSent = body;
      lastSentAt = Date.now();
    }
  } catch {
    /* display offline; the heartbeat retries */
  }
}

setInterval(() => {
  // re-evaluate timeouts, pick up branch / context changes, keep "last seen" fresh
  const due = Date.now() - lastSentAt > CONFIG.heartbeatSeconds * 1000;
  push(due);
}, 2000);

// --------------------------------------------------------------- server ----

const KEEP = [
  "hook_event_name",
  "conversation_id",
  "generation_id",
  "session_id",
  "model",
  "model_id",
  "model_params",
  "cursor_version",
  "status",
  "loop_count",
  "tool_name",
  "duration",
  "duration_ms",
  "subagent_type",
  "subagent_model",
  "is_parallel_worker",
  "composer_mode",
  "is_background_agent",
  "reason",
  "final_status",
  "trigger",
  "context_usage_percent",
  "context_tokens",
  "context_window_size",
  "message_count",
  "messages_to_compact",
  "is_first_compaction",
  "failure_type",
];

function logEvent(e) {
  if (!CONFIG.logEvents) return;
  const o = { at: new Date().toISOString() };
  for (const k of KEEP) if (e[k] !== undefined) o[k] = e[k];
  o.keys = Object.keys(e);
  fs.appendFile(LOG, JSON.stringify(o) + "\n", () => {});
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/window") {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 64e3) req.destroy();
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(body);
        if (typeof value.root !== "string" || !path.isAbsolute(value.root))
          throw new Error("absolute root required");
        windowRoot = value.root;
        res.end("{}");
        schedulePush();
      } catch {
        res.statusCode = 400;
        res.end("bad window");
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/selection") {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 64e3) req.destroy();
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(body);
        if (typeof value.model !== "string" || !value.model)
          throw new Error("model required");
        selected = {
          model: value.model,
          params: paramsToObject(value.params),
          at: Date.now(),
        };
        res.end("{}");
        schedulePush();
      } catch {
        res.statusCode = 400;
        res.end("bad selection");
      }
    });
    return;
  }
  if (req.method === "POST" && req.url === "/event") {
    let body = "";
    req.on("data", (d) => {
      body += d;
      if (body.length > 5e6) req.destroy();
    });
    req.on("end", () => {
      res.end("{}");
      try {
        const e = JSON.parse(body);
        logEvent(e);
        handle(e);
      } catch {
        /* ignore */
      }
    });
    return;
  }
  if (req.method === "GET" && req.url === "/state") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        { display: snapshot(), conversations: [...convs.values()] },
        null,
        2,
      ),
    );
    return;
  }
  res.statusCode = 404;
  res.end();
});

server.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(
    `cursor display bridge on 127.0.0.1:${CONFIG.port} -> ${CONFIG.device}`,
  );
  push(true);
});
