#!/usr/bin/env node
// What Cmd+Shift+T does, for agents. The mod does not load or start this process.
//   node agent.mjs                       MCP server (stdio)
//   node agent.mjs --http PORT           loopback JSON API (0 picks a port; prints its URL)
//   node agent.mjs list [--md]           closed tabs, newest first
//   node agent.mjs reopen [--tab ID] [--md]
// An agent's reopen goes through the mod itself (`herdr-app do mod.open`), with
// data/reopen-tab/request.json naming the tab and result.json answering.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { closedTabs, nextClose, readLedger, describe, names, RESUME } from "./plan.js";

export const tools = JSON.parse(await readFile(new URL("./agent-tools.json", import.meta.url), "utf8"));
const MOD = "reopen-tab";
const REOPEN_MS = 30000;
const EXE = process.platform === "win32" ? ".exe" : "";

export const home = () => process.env.HERDR_APP_HOME || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "herdr-app");
const data = (name) => join(home(), "data", MOD, name);

function run(bin, args, timeout = 15000) {
  return new Promise((done) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) =>
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout), stderr: String(stderr || error?.message || "") }));
  });
}

const onPath = (name) => (process.env.PATH || "").split(delimiter).filter(Boolean).map((d) => join(d, name + EXE)).find(existsSync);

/** The app's CLI: HERDR_APP_BIN, PATH, the link the Mac app makes, the Mac app itself. */
export function appBin() {
  if (process.env.HERDR_APP_BIN) return process.env.HERDR_APP_BIN;
  const places = [join(homedir(), ".local/bin/herdr-app"), "/Applications/Herdr.app/Contents/MacOS/Herdr"];
  return onPath("herdr-app") || places.find(existsSync) || "herdr-app";
}

let core;
/** The herdr-core the app uses: settings.json `core`, else PATH, else where it gets installed. */
export async function coreBin() {
  if (core) return core;
  let configured = null;
  try {
    configured = JSON.parse(await readFile(join(home(), "settings.json"), "utf8")).core || null;
  } catch (_) {}
  const dirs = [...(process.env.PATH || "").split(delimiter).filter(Boolean), ...[".local/bin", ".local/share/mise/shims", ".nix-profile/bin", ".cargo/bin"].map((d) => join(homedir(), d)), "/opt/homebrew/bin", "/usr/local/bin"];
  const candidates = [configured && configured.replace(/^~\//, homedir() + "/"), ...dirs.flatMap((d) => [join(d, "herdr-core" + EXE), join(d, "hc" + EXE)])].filter((c) => c && existsSync(c));
  for (const c of candidates) if ((await run(c, ["--version"], 5000)).stdout.startsWith("hc ")) return (core = c);
  throw new Error("herdr-core (hc) not found; set `core` in Herdr's settings.json");
}

/** `herdr-app <args>` as JSON; its `{error}` and a missing window become errors. */
async function app(args, timeout) {
  const r = await run(appBin(), args, timeout);
  let out = null;
  try {
    out = JSON.parse(r.stdout);
  } catch (_) {}
  if (out?.error) throw new Error(typeof out.error === "string" ? out.error : JSON.stringify(out.error));
  if (r.code !== 0 || !out) throw new Error((r.stderr || r.stdout).trim() || `herdr-app ${args[0]} failed`);
  return out;
}

async function hc(args) {
  const r = await run(await coreBin(), args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `hc ${args[0]} failed`);
  return JSON.parse(r.stdout);
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (_) {
    return "";
  }
}

/** What agents read and run; tests swap in fakes. */
export const io = {
  app,
  hc,
  read: (name) => readText(data(name)),
  write: async (name, value) => {
    await mkdir(join(home(), "data", MOD), { recursive: true });
    await writeFile(data(name), JSON.stringify(value, null, 2) + "\n");
  },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Finished terminals killed while in a Herdr tab, as `hc get` has them (like the mod's own). */
async function closedRecords(io) {
  const listed = ((await io.hc(["ls", "--all", "--json"])).terminals || []).filter((t) => t.state === "finished" && t.reason === "killed" && t.where);
  const records = [];
  for (let i = 0; i < listed.length; i += 16) {
    const batch = await Promise.all(listed.slice(i, i + 16).map((t) => io.hc(["get", t.address, "--json"]).then((r) => ({ ...r, address: t.address }), () => null)));
    records.push(...batch.filter(Boolean));
  }
  return records;
}

export async function listClosed(io_ = io) {
  // A live window first: what's open is what the window shows now.
  const world = await io_.app(["ls"]);
  const records = await closedRecords(io_);
  const ledger = readLedger(await io_.read("ledger.json"));
  const open = new Set(world.spaces.flatMap((s) => s.tabs.map((t) => t.id)));
  const tabs = closedTabs(records, open, new Set(ledger.tabs), ledger.born);
  const plan = nextClose(tabs, new Set(world.spaces.map((s) => s.id)), ledger.spaces);
  return {
    closed: tabs.map((t) => describe(t, RESUME)),
    next: plan && { tabs: plan.tabs.map((t) => t.tab), new_space: plan.newSpace, space: plan.space, space_name: names(plan.where || plan.tabs[0].where).space || null },
  };
}

export async function reopenClosed(args = {}, io_ = io, timeout = REOPEN_MS) {
  const id = randomUUID();
  await io_.write("request.json", { id, tab: args.tab || null, at: Date.now() });
  try {
    await io_.app(["do", "mod.open", JSON.stringify({ name: MOD })]);
  } catch (e) {
    await io_.write("request.json", { id: null, at: 0 });
    throw new Error(/no mod folder/.test(e.message) ? `The reopen-tab mod isn't installed in ${join(home(), "mods", MOD)}` : e.message);
  }
  for (const end = Date.now() + timeout; Date.now() < end; await io_.wait(100)) {
    let result = null;
    try {
      result = JSON.parse(await io_.read("result.json"));
    } catch (_) {}
    if (result?.id !== id) continue;
    if (!result.ok) throw new Error(result.error || "reopen failed");
    return { reopened: result.reopened || [], new_space: !!result.new_space };
  }
  throw new Error(`The reopen-tab mod did not answer in ${timeout / 1000}s`);
}

export function validate(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  const schema = tool.inputSchema;
  for (const key of Object.keys(args)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`unknown argument: ${key}`);
  for (const key of schema.required ?? []) if (!Object.hasOwn(args, key)) throw new Error(`missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== schema.properties[key].type || (schema.properties[key].minLength && !value.trim())) throw new Error(`invalid argument: ${key}`);
  }
}

const handlers = { herdr_closed_tabs_list: () => listClosed(), herdr_closed_tab_reopen: (args) => reopenClosed(args) };

export async function callTool(name, args = {}, call = handlers) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  validate(tool, args);
  return call[name](args);
}

/** The same answers as Markdown, for people and agents that read it. */
export function markdown(name, result) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "\\|");
  const panes = (c) => c.panes.map((p) => `\`${cell(p.folder || "~")}\`${p.command ? ` ${cell(p.command.join(" "))}` : ""}`).join("<br>");
  if (name === "herdr_closed_tabs_list") {
    if (!result.closed.length) return "No closed tab to reopen.\n";
    const rows = result.closed.map((c, i) => `| ${i + 1} | ${cell(c.name || "(unnamed)")} | ${cell(c.space_name || "")}${c.machine ? ` (${cell(c.machine)})` : ""} | ${c.closed_at || ""} | ${panes(c)} | \`${c.tab}\` |`);
    const next = result.next ? `Cmd+Shift+T brings back ${result.next.new_space ? `the space ${result.next.space_name || ""} with ${result.next.tabs.length} tab(s)` : `\`${result.next.tabs[0]}\``}.\n\n` : "";
    return `# Closed tabs, newest first\n\n${next}| # | Tab | Space | Closed | Panes | id |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
  }
  if (!result.reopened.length) return "No closed tab to reopen.\n";
  const lines = result.reopened.map((c) => `- ${cell(c.name || "(unnamed)")} in ${cell(c.space_name || "its space")}: ${c.panes.length} pane(s), now tab \`${c.now.tab}\``);
  return `# Reopened${result.new_space ? " with its space" : ""}\n\n${lines.join("\n")}\n`;
}

const serverInfo = { name: "herdr-reopen-tab", version: "1.0.0" };
// A small MCP 2025-11-25 stdio server, like Herdr's own mods/tabs/agent.mjs.
export async function rpc(request, call = callTool) {
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string")
    return { jsonrpc: "2.0", id: request?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
  if (!Object.hasOwn(request, "id")) return null;
  const response = { jsonrpc: "2.0", id: request.id };
  switch (request.method) {
    case "initialize": return { ...response, result: { protocolVersion: "2025-11-25", serverInfo, capabilities: { tools: {} } } };
    case "ping": return { ...response, result: {} };
    case "tools/list": return { ...response, result: { tools: tools.map(({ http, cli, command, uiActions, ...tool }) => tool) } };
    case "tools/call": {
      try {
        const name = request.params?.name;
        const result = await call(name, request.params?.arguments ?? {});
        return { ...response, result: { content: [{ type: "text", text: JSON.stringify(result) }, { type: "text", text: markdown(name, result) }], structuredContent: result } };
      } catch (error) {
        return { ...response, result: { isError: true, content: [{ type: "text", text: error.message }] } };
      }
    }
    default: return { ...response, error: { code: -32601, message: "Method not found" } };
  }
}

export function httpServer(call = callTool) {
  return createServer(async (req, res) => {
    const md = /\bmarkdown\b/.test(req.headers.accept || "");
    const send = (status, value, name) => {
      res.writeHead(status, { "Content-Type": md && name ? "text/markdown; charset=utf-8" : "application/json", "Cache-Control": "no-store" });
      res.end(md && name ? markdown(name, value) : JSON.stringify(value));
    };
    // A local agent API, not a browser endpoint: no browser origins, loopback Host only.
    if (req.headers.origin || !/^127\.0\.0\.1:\d+$/.test(req.headers.host ?? "")) return send(403, { error: "Loopback agent clients only" });
    if (req.method === "GET" && req.url === "/v1/tools") return send(200, { tools });
    const tool = tools.find((t) => t.http.method === req.method && t.http.path === req.url);
    if (!tool) return send(404, { error: "Unknown endpoint" });
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 16384) return send(413, { error: "Request too large" });
      }
      send(200, await call(tool.name, body ? JSON.parse(body) : {}), tool.name);
    } catch (error) {
      send(400, { error: error.message });
    }
  });
}

export const usage = `usage: herdr-reopen-tab [list [--md] | reopen [--tab ID] [--md] | --http PORT]
  (no command)   MCP server on stdio: ${tools.map((t) => t.name).join(", ")}
${tools.map((t) => `  ${t.cli.padEnd(14)} ${t.http.method} ${t.http.path}, MCP ${t.name}`).join("\n")}
  --http PORT    loopback JSON API (0 picks a port); GET /v1/tools lists the schemas`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h" || cmd === "help") return console.log(usage);
  if (cmd === "--http") {
    const port = Number(rest[0] ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0..65535");
    const server = httpServer();
    server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` })));
    server.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
    return;
  }
  const tool = cmd && tools.find((t) => t.cli === cmd);
  if (tool) {
    const md = rest.includes("--md");
    const flags = rest.filter((a) => a !== "--md");
    const args = {};
    for (let i = 0; i < flags.length; i++) {
      const key = flags[i].replace(/^--/, "");
      if (!flags[i].startsWith("--") || flags[i + 1] === undefined) throw new Error(usage);
      args[key] = flags[++i];
    }
    try {
      const result = await callTool(tool.name, args);
      process.stdout.write(md ? markdown(tool.name, result) : JSON.stringify(result, null, 2) + "\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }) + "\n");
      process.exitCode = 1;
    }
    return;
  }
  if (cmd) throw new Error(usage);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let reply;
    try {
      reply = await rpc(JSON.parse(line));
    } catch {
      reply = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (reply) process.stdout.write(JSON.stringify(reply) + "\n");
  }
}

// Run directly, or through a link such as ~/.local/bin/herdr-reopen-tab.
const direct = () => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch (_) {
    return false;
  }
};
if (process.argv[1] && direct())
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
