/**
 * ruyijs tool: run a site's own JavaScript in the real Firefox engine (SpiderMonkey + Necko).
 *
 * One daemon process per (session, origin). It is spawned on first use and killed after
 * `idleSeconds` without a call, so a multi-step flow keeps its JS world without paying for a
 * permanently resident process.
 *
 * Nothing here hard-codes the host installation: the Python interpreter is discovered, and
 * `@deepseek-ai/dsh-tools` is resolved with fallbacks, so a moved DSH install or a different
 * Python minor version keeps working.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

export const name = "tool-ruyijs";
export const inject = ["tools"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "runner.py");
const RUNS = path.resolve(HERE, "..", "runs");

const DEFAULT_IDLE_MS = 180_000;
const DEFAULT_MAX_BYTES = 65_536;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const PY_CHECK_TIMEOUT_MS = 20_000;
/** How long a timed-out op keeps its context alive while the runner may still
 * answer it. Only after this does the context get torn down. */
const TIMEOUT_GRACE_MS = 15_000;

/** @type {Map<string, {child: any, queue: Promise<any>, pending: any[], idle: any, idleMs?: number, stderr: string}>} */
const daemons = new Map();

let resolvedPython = null;

// ── host resolution ─────────────────────────────────────────────────────────

/** Resolve `@deepseek-ai/dsh-tools` without depending on a single local layout. */
async function loadDefineTool() {
  const tries = [
    "@deepseek-ai/dsh-tools",
    ...candidateHostPackages("dsh-tools").map((file) => pathToFileURL(file).href),
  ];
  const failures = [];
  for (const spec of tries) {
    try {
      const mod = await import(spec);
      if (typeof mod.defineTool === "function") return mod.defineTool;
      failures.push(`${spec}: no defineTool export`);
    } catch (error) {
      failures.push(`${spec}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`ruyijs plugin cannot load @deepseek-ai/dsh-tools\n${failures.join("\n")}`);
}

/** Plausible host node_modules locations around this process. */
function candidateHostPackages(pkg) {
  const roots = [];
  if (process.env.DSH_APP_DIR) roots.push(path.join(process.env.DSH_APP_DIR, "node_modules", "@deepseek-ai"));
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "app", "dsh", "node_modules", "@deepseek-ai"));
  const exeDir = path.dirname(process.execPath ?? "");
  roots.push(path.join(exeDir, "resources", "app", "dsh", "node_modules", "@deepseek-ai"));
  roots.push(path.join(exeDir, "..", "resources", "app", "dsh", "node_modules", "@deepseek-ai"));
  return roots.map((root) => path.join(root, pkg, "lib", "index.js")).filter((file) => {
    try { return fs.existsSync(file); } catch { return false; }
  });
}

/** Candidate interpreters, most specific first. */
function pythonCandidates() {
  const list = [];
  if (process.env.RUYIJS_PY) list.push(process.env.RUYIJS_PY);
  list.push("python.exe", "python", "py");

  const bases = [
    path.join(os.homedir(), "AppData", "Local", "Programs", "Python"),
    "C:\\Python",
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Python") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "Python") : null,
  ];
  for (const base of bases) {
    if (!base) continue;
    try {
      for (const entry of fs.readdirSync(base)) {
        if (!/^Python3\d+$/i.test(entry)) continue;
        const exe = path.join(base, entry, "python.exe");
        if (fs.existsSync(exe)) list.push(exe);
      }
    } catch { /* directory absent */ }
  }
  return [...new Set(list.filter(Boolean))];
}

function probePython(candidate) {
  const args = candidate === "py" ? ["-3", "-c", "import sys,ruyijs;print(sys.executable)"] : ["-c", "import sys,ruyijs;print(sys.executable)"];
  const result = spawnSync(candidate, args, { encoding: "utf8", timeout: PY_CHECK_TIMEOUT_MS, windowsHide: true });
  if (result.status !== 0) return null;
  const resolved = (result.stdout ?? "").trim().split(/\r?\n/).pop();
  return resolved && fs.existsSync(resolved) ? resolved : null;
}

/** First interpreter that can import ruyijs; cached for the process lifetime. */
function pythonPath() {
  if (resolvedPython) return resolvedPython;
  const tried = [];
  for (const candidate of pythonCandidates()) {
    const ok = probePython(candidate);
    if (ok) { resolvedPython = ok; return resolvedPython; }
    tried.push(candidate);
  }
  throw new Error(`ruyijs: no Python with the ruyijs package (tried ${tried.join(", ")}). Set RUYIJS_PY or run: python -m pip install ruyijs`);
}

// ── daemons ─────────────────────────────────────────────────────────────────

function originOf(url) {
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

/** session id -> the origin its latest call used, so a url-less call rejoins that context. */
const lastOrigin = new Map();

function sessionOf(exec) {
  return exec?.agent?.session?.id ?? "host";
}

function keyOf(exec, url) {
  const session = sessionOf(exec);
  const named = originOf(url);
  if (named) {
    lastOrigin.set(session, named);
    return `${session}|${named}`;
  }
  return `${session}|${lastOrigin.get(session) ?? "*"}`;
}

function start(key) {
  const live = daemons.get(key);
  if (live) return live;

  fs.mkdirSync(RUNS, { recursive: true });
  const child = spawn(pythonPath(), ["-X", "utf8", "-u", RUNNER], {
    cwd: RUNS,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const entry = { child, queue: Promise.resolve(), pending: [], idle: null, stderr: "" };
  daemons.set(key, entry);

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
      if (!line.trim()) continue;
      const waiter = entry.pending.shift();
      if (!waiter) continue;
      let payload;
      try { payload = JSON.parse(line); } catch { payload = { ok: false, error: "bad runner output" }; }
      waiter.forgotten = true;
      waiter.resolve(payload);
    }
    if (buffer.length > MAX_LINE_BYTES) buffer = "";
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    entry.stderr = (entry.stderr + chunk).slice(-8192);
  });

  child.on("exit", (code) => {
    daemons.delete(key);
    const reason = entry.stderr.trim() || `runner exited (${code})`;
    for (const waiter of entry.pending.splice(0)) waiter.reject(new Error(reason));
  });

  return entry;
}

function send(key, message, timeoutMs) {
  const entry = start(key);
  if (entry.idle) { clearTimeout(entry.idle); entry.idle = null; }

  const task = () => new Promise((resolve, reject) => {
    const waiter = { resolve, reject, timers: [], settled: false, forgotten: false };
    entry.pending.push(waiter);

    const timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      reject(new Error(`ruyijs op timed out after ${timeoutMs} ms`));
      // The waiter stays queued on purpose: the runner still owes this op a
      // reply, and pulling it out now would hand that late reply to the next
      // waiter and desync every op after it. Only the promise settles here.
      // The context dies only if the reply never comes at all.
      const grace = setTimeout(() => {
        if (waiter.forgotten) return;
        kill(key);
      }, TIMEOUT_GRACE_MS);
      grace.unref?.();
      waiter.timers.push(grace);
    }, timeoutMs);
    waiter.timers.push(timer);

    waiter.resolve = (value) => {
      waiter.settled = true;
      waiter.forgotten = true;
      for (const t of waiter.timers) clearTimeout(t);
      resolve(value);
    };
    waiter.reject = (error) => {
      for (const t of waiter.timers) clearTimeout(t);
      reject(error);
    };
    entry.child.stdin.write(`${JSON.stringify(message)}\n`);
  });

  const next = entry.queue.then(task, task);
  entry.queue = next.catch(() => {});
  return next;
}

function kill(key) {
  const entry = daemons.get(key);
  if (!entry) return false;
  daemons.delete(key);
  if (entry.idle) clearTimeout(entry.idle);
  const { child } = entry;
  try { child.stdin.end(); } catch { /* already gone */ }

  // A busy runner does not reach its EOF handler, and the idle timer is already cleared, so
  // nothing else would ever reap this tree. `taskkill /T` reaches the js.exe shell and its
  // detached workers; `child.kill()` alone only kills the runner, leaving orphans behind.
  const reap = () => {
    if (child.exitCode !== null) return;
    if (child.pid) {
      try {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } catch { /* fall through to the signal */ }
    }
    if (child.exitCode === null) {
      try { child.kill(); } catch { /* already gone */ }
    }
  };
  const timer = setTimeout(reap, 600);
  timer.unref?.();
  child.on("exit", () => clearTimeout(timer));
  return true;
}

function armIdle(key, idleMs) {
  const entry = daemons.get(key);
  if (!entry) return;
  entry.idleMs = idleMs;
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = setTimeout(() => kill(key), idleMs);
  entry.idle.unref?.();
}

// ── payload shaping ─────────────────────────────────────────────────────────

function clip(value, maxBytes) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null) ?? "";
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false, bytes };
  return { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true, bytes };
}

function tail(list, count) {
  return Array.isArray(list) ? list.slice(-count) : [];
}

function spill(label, text) {
  fs.mkdirSync(RUNS, { recursive: true });
  const file = path.join(RUNS, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}.txt`);
  fs.writeFileSync(file, text, "utf8");
  pruneRuns();
  return file;
}

const RUNS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RUNS_MAX_BYTES = 200 * 1024 * 1024;

/**
 * Keep `runs/` bounded: drop files older than a week, then, if the directory is still
 * over its byte budget, drop the oldest ones until it fits. Best effort — a pruning
 * failure never breaks a tool call.
 */
function pruneRuns() {
  try {
    const entries = fs.readdirSync(RUNS, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = path.join(RUNS, entry.name);
        const stat = fs.statSync(file);
        return { file, size: stat.size, mtime: stat.mtimeMs };
      });

    const cutoff = Date.now() - RUNS_MAX_AGE_MS;
    const kept = [];
    for (const item of entries) {
      if (item.mtime < cutoff) {
        try { fs.unlinkSync(item.file); } catch { /* locked */ }
      } else {
        kept.push(item);
      }
    }

    let total = kept.reduce((sum, item) => sum + item.size, 0);
    if (total <= RUNS_MAX_BYTES) return;
    kept.sort((a, b) => a.mtime - b.mtime);
    for (const item of kept) {
      if (total <= RUNS_MAX_BYTES) break;
      try {
        fs.unlinkSync(item.file);
        total -= item.size;
      } catch { /* locked */ }
    }
  } catch { /* directory missing or unreadable */ }
}

/** Uniform failure payload: one shape for timeouts, runner deaths, navigation and JS errors. */
function failure(message, extra = {}) {
  return {
    ok: false,
    text: "",
    value: null,
    error: message,
    name: extra.name ?? null,
    stack: extra.stack ?? null,
    console: [],
    net: [],
    truncated: false,
    spilledTo: null,
  };
}

const NO_CONTEXT = "no live ruyijs context for this origin (it was closed, timed out, or idled out) — pass the url again to open one";

function describe(extra) {
  return "Run JavaScript in a real Firefox engine (SpiderMonkey + Necko), headless, no renderer. "
    + "Use it when a page's body or signature only appears after its own scripts run, when a bot check "
    + "must be passed, or when a site checks the TLS fingerprint — cases where plain HTTP and headless "
    + "Chrome get blocked. It cannot screenshot, click, scroll, or report layout. "
    + "The context stays alive between calls for the same origin until `idleSeconds` pass; variables and "
    + "the loaded page persist across calls, so split multi-step flows instead of one huge script. "
    + extra;
}

// ── tools ───────────────────────────────────────────────────────────────────

// Resolved at module load (top-level await) so `apply` stays synchronous, which the
// loader always supports regardless of async-apply handling.
const defineTool = await loadDefineTool();

// Trim the spill directory once per host start, so an old backlog never survives a restart.
pruneRuns();

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "ruyijs_run",
    description: describe("Returns the evaluated value, plus the newest console and network records."),
    parameters: {
      js: {
        type: "string",
        required: true,
        description: "JavaScript to evaluate. Its value is returned; use a plain expression or an async IIFE with advanceMs.",
      },
      url: {
        type: "string",
        description: "Navigate here first. Reuse the same url across calls to keep the page and world. Required again after the context was closed or idled out.",
      },
      advanceMs: {
        type: "number",
        description: "Milliseconds of event-loop advancement after the eval, for timers, fetch and promise settlement.",
      },
      read: {
        type: "string",
        description: "Expression evaluated after advanceMs whose value is returned instead of the eval's.",
      },
      proxy: {
        type: "string",
        description: "Proxy for a freshly spawned context: http://, https:// or socks5://. Ignored on reuse.",
      },
      fingerprint: {
        type: "object",
        additionalProperties: true,
        description: "Fingerprint profile for a freshly spawned context, e.g. {\"navigator\":{\"language\":\"zh-CN\"},\"locale\":{\"timezone\":\"Asia/Shanghai\"}}.",
      },
      timeoutMs: { type: "number", description: "Per-op timeout, default 60000." },
      idleSeconds: { type: "number", description: "Idle seconds before the context is killed, default 180." },
      maxBytes: { type: "number", description: "Byte cap for the returned text and value, default 65536; overflow is spilled to a file." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean", required: true },
          text: { type: "string" },
          error: { oneOf: [{ type: "string" }, { type: "null" }] },
          name: { oneOf: [{ type: "string" }, { type: "null" }] },
          stack: { oneOf: [{ type: "string" }, { type: "null" }] },
          console: { type: "array" },
          net: { type: "array" },
          truncated: { type: "boolean" },
          spilledTo: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: "text", text: `ruyijs failed: ${value.error ?? "unknown"}${value.name ? ` (${value.name})` : ""}` }];
        const head = `ruyijs ok: ${(value.text ?? "").slice(0, 400)}`;
        const spillNote = value.spilledTo ? `\n[truncated to ${value.text.length} chars; full output: ${value.spilledTo}]` : "";
        return [{ type: "text", text: head + spillNote }];
      },
    },
    async execute(args, exec) {
      const timeoutMs = args.timeoutMs ?? 60_000;
      const maxBytes = args.maxBytes ?? DEFAULT_MAX_BYTES;
      const idleMs = (args.idleSeconds ?? 180) * 1000;
      const base = { proxy: args.proxy, fingerprint: args.fingerprint, timeout: Math.ceil(timeoutMs / 1000) };

      const key = keyOf(exec, args.url);
      if (!args.url && !daemons.has(key)) return failure(NO_CONTEXT);

      try {
        if (args.url) {
          const nav = await send(key, { op: "navigate", url: args.url, ...base }, timeoutMs);
          if (!nav.ok) {
            armIdle(key, idleMs);
            return failure(nav.error ?? "navigate failed", { name: nav.name, stack: nav.stack });
          }
        }

        let result = await send(key, { op: "eval", js: args.js, ...base }, timeoutMs);
        if (result.ok && args.advanceMs) {
          await send(key, { op: "advance", ms: args.advanceMs, ...base }, timeoutMs);
          if (args.read) result = await send(key, { op: "read", js: args.read, ...base }, timeoutMs);
        }

        const logs = result.ok ? await send(key, { op: "logs" }, timeoutMs).catch(() => null) : null;
        armIdle(key, idleMs);

        if (!result.ok) return failure(result.error ?? "eval failed", { name: result.name, stack: result.stack });

        const { text, truncated: clipped } = clip(result.value, maxBytes);
        const truncated = clipped || result.cut === true;
        const payload = {
          ok: true,
          text,
          value: truncated ? text : (result.value === undefined ? null : result.value),
          error: null,
          name: null,
          stack: null,
          console: tail(logs?.console, 40),
          net: tail(logs?.net, 40),
          truncated,
          spilledTo: null,
        };
        if (truncated) {
          payload.spilledTo = spill("value", typeof result.value === "string" ? result.value : JSON.stringify(result.value ?? null));
        }
        return payload;
      } catch (error) {
        // A dead runner, a timeout, or a missing interpreter: same shape as a JS error.
        return failure(errorMessage(error));
      }
    },
    presentCall: (args) => ({ card: "generic", title: `ruyijs · ${args.url ?? "eval"}`, kind: "other", rawInput: args.js }),
  }));

  ctx.tools.register(defineTool({
    name: "ruyijs_net",
    description: "Read the request log and console records of the live ruyijs context for a url's origin.",
    parameters: {
      url: { type: "string", description: "Any url on the target origin; omitting it reuses the session's last origin." },
      count: { type: "number", description: "How many newest records to return, default 50." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          ok: { type: "boolean", required: true },
          net: { type: "array" },
          console: { type: "array" },
          error: { oneOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: value.ok
          ? `${value.net.length} requests, ${value.console.length} console records`
          : `ruyijs_net failed: ${value.error ?? "unknown"}`,
      }],
    },
    async execute(args, exec) {
      const key = keyOf(exec, args.url);
      if (!daemons.has(key)) return { ok: false, net: [], console: [], error: NO_CONTEXT };
      try {
        const result = await send(key, { op: "logs" }, 30_000);
        armIdle(key, daemons.get(key)?.idleMs ?? DEFAULT_IDLE_MS);
        const count = args.count ?? 50;
        return {
          ok: result.ok === true,
          net: tail(result.net, count),
          console: tail(result.console, count),
          error: result.ok ? null : (result.error ?? "logs failed"),
        };
      } catch (error) {
        return { ok: false, net: [], console: [], error: errorMessage(error) };
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: "ruyijs_close",
    description: "Kill the ruyijs context for an origin, or every context when no url is given.",
    parameters: {
      url: { type: "string", description: "Any url on the target origin; omit to close every context." },
    },
    output: {
      schema: { type: "object", additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: "text", text: `closed ${value.closed} context(s)` }],
    },
    async execute(args) {
      const targets = args.url
        ? [...daemons.keys()].filter((key) => key.endsWith(`|${originOf(args.url)}`))
        : [...daemons.keys()];
      for (const key of targets) kill(key);
      if (!args.url) lastOrigin.clear();
      return { ok: true, closed: targets.length };
    },
  }));

  ctx.on("dispose", () => {
    for (const key of [...daemons.keys()]) kill(key);
  });
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : JSON.stringify(error);
}
