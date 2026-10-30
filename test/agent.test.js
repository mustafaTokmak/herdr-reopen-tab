import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFile, readdir, mkdtemp, cp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tools, rpc, httpServer, callTool, listClosed, reopenClosed, markdown, usage } from "../mods/reopen-tab/agent.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const agent = join(root, "mods/reopen-tab/agent.mjs");
const request = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });

test("every key and every mod a person can open has an MCP tool, a JSON API and a CLI command", async () => {
  const keys = JSON.parse(await readFile(join(root, "keys.json"), "utf8"));
  const actions = new Set(Object.values(keys).flatMap((section) => Object.values(section)));
  for (const dir of await readdir(join(root, "mods"))) {
    const mod = JSON.parse(await readFile(join(root, "mods", dir, "mod.json"), "utf8"));
    if (mod.overlay) actions.add(`mod.open:${dir}`);
  }
  assert.ok(actions.size);
  for (const action of actions) {
    const tool = tools.find((t) => t.command === action);
    assert.ok(tool, `${action} has no agent tool in agent-tools.json`);
    assert.ok(tool.name && tool.http?.method && tool.http?.path && tool.cli, `${action} lacks an MCP name, HTTP route or CLI command`);
  }
  for (const t of tools) assert.ok(t.uiActions.length, `${t.name} names no human action`);
  for (const field of [(t) => t.name, (t) => `${t.http.method} ${t.http.path}`, (t) => t.cli]) assert.equal(new Set(tools.map(field)).size, tools.length);
});

test("the MCP server, the JSON API and the CLI each offer every tool", async () => {
  const child = spawn(process.execPath, [agent], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(JSON.stringify(request("tools/list")) + "\n");
  await new Promise((r) => child.on("close", r));
  assert.deepEqual(JSON.parse(out).result.tools.map((t) => t.name), tools.map((t) => t.name));

  const server = httpServer(async () => ({ closed: [], next: null }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual((await (await fetch(`${url}/v1/tools`)).json()).tools.map((t) => t.name), tools.map((t) => t.name));
    for (const t of tools) assert.equal((await fetch(url + t.http.path, { method: t.http.method, body: t.http.method === "POST" ? "{}" : undefined })).status, 200, t.name);
    assert.equal((await fetch(`${url}/v1/closed-tabs`, { headers: { Origin: "https://example.com" } })).status, 403);
    assert.equal((await fetch(`${url}/v1/closed-tabs`, { headers: { Accept: "text/markdown" } })).headers.get("content-type"), "text/markdown; charset=utf-8");
  } finally {
    server.close();
  }

  const help = execFileSync(process.execPath, [agent, "--help"], { encoding: "utf8" });
  assert.equal(help.trim(), usage);
  for (const t of tools) assert.match(help, new RegExp(`\\b${t.cli}\\b.*${t.name}`));
});

test("MCP answers the protocol and reports tool errors as results", async () => {
  assert.equal((await rpc(request("initialize"))).result.protocolVersion, "2025-11-25");
  assert.deepEqual((await rpc(request("ping"))).result, {});
  assert.equal(await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal((await rpc(request("nope"))).error.code, -32601);
  const ok = (await rpc(request("tools/call", { name: "herdr_closed_tabs_list", arguments: {} }), async () => ({ closed: [], next: null }))).result;
  assert.deepEqual(ok.structuredContent, { closed: [], next: null });
  assert.equal(ok.content[1].text, "No closed tab to reopen.\n");
  assert.equal((await rpc(request("tools/call", { name: "unknown" }))).result.isError, true);
  await assert.rejects(callTool("herdr_closed_tab_reopen", { tab: "" }), /invalid argument: tab/);
  await assert.rejects(callTool("herdr_closed_tab_reopen", { other: "x" }), /unknown argument/);
});

const killed = (address, tab, finished, created, where) => ({
  address, state: "finished", reason: "killed", finished_ms: finished, created_ms: created, argv: ["/bin/zsh"], cwd: "/work",
  labels: { "herdr.space": "sp1", "herdr.tab": tab, where },
});

test("list reads the window, the core's records and the ledger like the mod does", async () => {
  const records = [killed("t1", "tbA", 9000, 100, "proj / api"), killed("t2", "tbB", 5000, 200, "proj / web"), killed("t3", "tbC", 7000, 300, "proj / old")];
  const fake = {
    app: async (args) => (assert.deepEqual(args, ["ls"]), { spaces: [{ id: "sp1", tabs: [{ id: "tbOpen" }] }] }),
    hc: async (args) => (args[0] === "ls" ? { terminals: [...records.map((r) => ({ ...r, where: r.labels.where })), { address: "t9", state: "live", where: "proj / x" }] } : records.find((r) => r.address === args[1])),
    read: async (name) => (name === "ledger.json" ? JSON.stringify({ tabs: ["tbC"] }) : ""),
  };
  const out = await listClosed(fake);
  assert.deepEqual(out.closed.map((c) => [c.tab, c.name]), [["tbA", "api"], ["tbB", "web"]]);
  assert.deepEqual(out.next, { tabs: ["tbA"], new_space: false, space: "sp1", space_name: "proj" });
  assert.match(markdown("herdr_closed_tabs_list", out), /Cmd\+Shift\+T brings back `tbA`[\s\S]*\| 1 \| api \| proj \|/);
});

test("reopen asks the mod through a request file and returns its matching answer", async () => {
  const files = {};
  let opened = 0;
  const fake = {
    write: async (name, value) => (files[name] = JSON.stringify(value)),
    read: async (name) => files[name] || "",
    app: async (args) => {
      assert.deepEqual(args, ["do", "mod.open", '{"name":"reopen-tab"}']);
      opened++;
      setTimeout(() => (files["result.json"] = JSON.stringify({ id: "stale", ok: true, reopened: [] })), 0);
      setTimeout(() => (files["result.json"] = JSON.stringify({ id: JSON.parse(files["request.json"]).id, ok: true, reopened: [{ tab: "tbA", panes: [], now: { tab: "tbN" } }], new_space: false })), 20);
    },
    wait: (ms) => new Promise((r) => setTimeout(r, ms / 20)),
  };
  const out = await reopenClosed({ tab: "tbA" }, fake);
  assert.equal(opened, 1);
  assert.equal(JSON.parse(files["request.json"]).tab, "tbA");
  assert.deepEqual(out, { reopened: [{ tab: "tbA", panes: [], now: { tab: "tbN" } }], new_space: false });

  fake.app = async () => setTimeout(() => (files["result.json"] = JSON.stringify({ id: JSON.parse(files["request.json"]).id, ok: false, error: "No closed tab tbZ to reopen" })), 5);
  await assert.rejects(reopenClosed({ tab: "tbZ" }, fake), /No closed tab tbZ/);
  fake.app = async () => { throw new Error('no mod folder "reopen-tab"'); };
  await assert.rejects(reopenClosed({}, fake), /isn't installed/);
  assert.equal(JSON.parse(files["request.json"]).id, null, "a failed open leaves no request for the next key press");
  fake.app = async () => {};
  await assert.rejects(reopenClosed({}, fake, 50), /did not answer/);
});

test("llms.txt, llms-full.txt and SKILL.md are generated from agent-tools.json", async () => {
  execFileSync(process.execPath, [join(root, "scripts/agent-docs.mjs"), "--check"]);
  const dir = await mkdtemp(join(tmpdir(), "reopen-tab-docs-"));
  await cp(root, dir, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes(".git") });
  try {
    await writeFile(join(dir, "mods/reopen-tab/llms.txt"), "outdated");
    assert.throws(() => execFileSync(process.execPath, [join(dir, "scripts/agent-docs.mjs"), "--check"], { stdio: "pipe" }), /stale/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
