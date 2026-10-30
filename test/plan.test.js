import { test } from "node:test";
import assert from "node:assert/strict";
import { unwrap, agentCommand, splitArgv, tabArgv, start, names, tabName, closedTabs, nextClose, position, readLedger, addToLedger, describe, KEEP } from "../mods/reopen-tab/plan.js";

const WRAP = ["/bin/zsh", "-ic", '"$@"; exec "$0" -i', "/bin/zsh"];
const REMOTE = ["sh", "-c", '"$@"; exec "${SHELL:-sh}" -i', "sh"];
const FISH = ["/opt/homebrew/bin/fish", "-ic", "command $argv[2..]; exec $argv[1] -i", "/opt/homebrew/bin/fish"];

test("unwrap finds the agent inside Herdr's shell wrappers", () => {
  assert.deepEqual(unwrap([...WRAP, "claude"]).cmd, ["claude"]);
  assert.deepEqual(unwrap([...REMOTE, "codex", "-m", "gpt-5"]).cmd, ["codex", "-m", "gpt-5"]);
  assert.deepEqual(unwrap([...FISH, "claude"]).cmd, ["claude"]);
  assert.deepEqual(unwrap([...WRAP, "claude"]).shell, WRAP);
});

test("unwrap treats plain shells as no command", () => {
  for (const argv of [["/bin/bash"], ["/bin/zsh", "-l"], ["fish", "--login"], [], null]) assert.equal(unwrap(argv).cmd, null);
  assert.deepEqual(unwrap(["htop"]).cmd, ["htop"]);
  assert.deepEqual(unwrap(["bash", "script.sh"]).cmd, ["bash", "script.sh"]);
});

test("claude resumes its last conversation and never re-sends its first task", () => {
  assert.deepEqual(agentCommand(["claude"]), ["claude", "--continue"]);
  assert.deepEqual(agentCommand(["claude", "fix the login bug"]), ["claude", "--continue"]);
  assert.deepEqual(agentCommand(["claude", "--model", "opus"]), ["claude", "--model", "opus", "--continue"]);
  assert.deepEqual(agentCommand(["claude", "--dangerously-skip-permissions", "look at the bug"]), ["claude", "--dangerously-skip-permissions", "--continue"]);
  assert.deepEqual(agentCommand(["/usr/local/bin/claude"]), ["/usr/local/bin/claude", "--continue"]);
});

test("a command that names its session is rerun as it was", () => {
  assert.deepEqual(agentCommand(["claude", "--resume", "ff21e1df-6f8f"]), ["claude", "--resume", "ff21e1df-6f8f"]);
  assert.deepEqual(agentCommand(["claude", "--resume", "ff21e1df-6f8f", "and now the tests"]), ["claude", "--resume", "ff21e1df-6f8f"]);
  assert.deepEqual(agentCommand(["codex", "resume", "0199-abc"]), ["codex", "resume", "0199-abc"]);
});

test("codex resumes the folder's last session", () => {
  assert.deepEqual(agentCommand(["codex"]), ["codex", "resume", "--last"]);
  assert.deepEqual(agentCommand(["codex", "-m", "gpt-5", "write the docs"]), ["codex", "resume", "--last", "-m", "gpt-5"]);
});

test("one-shot runs, subcommands and other programs are left alone", () => {
  assert.deepEqual(agentCommand(["claude", "-p", "summarize this"]), ["claude", "-p", "summarize this"]);
  assert.deepEqual(agentCommand(["claude", "doctor"]), ["claude", "doctor"]);
  assert.deepEqual(agentCommand(["codex", "exec", "run the tests"]), ["codex", "exec", "run the tests"]);
  assert.deepEqual(agentCommand(["lazygit"]), ["lazygit"]);
  assert.deepEqual(agentCommand(["claude"], {}), ["claude"]);
});

test("tabArgv gives tab.new the agent command, or nothing for a shell", () => {
  assert.deepEqual(tabArgv({ argv: [...WRAP, "claude", "--resume", "x"] }), ["claude", "--resume", "x"]);
  assert.equal(tabArgv({ argv: ["/bin/bash"] }), null);
});

test("splitArgv starts the pane's own command in its own folder", () => {
  const argv = splitArgv({ argv: [...WRAP, "claude"], cwd: "/src/app" });
  assert.deepEqual(argv.slice(0, 2), ["sh", "-c"]);
  assert.deepEqual(argv.slice(3), ["sh", "/src/app", ...WRAP, "claude", "--continue"]);
  assert.deepEqual(splitArgv({ argv: ["/bin/bash"], cwd: "/tmp" }).slice(3), ["sh", "/tmp", "/bin/bash"]);
  assert.deepEqual(splitArgv({ argv: [], cwd: "/tmp" }).slice(3), ["sh", "/tmp"]);
  assert.deepEqual(splitArgv({ argv: ["pwsh.exe", "-NoLogo"], cwd: "C:\\src" }), ["pwsh.exe", "-NoLogo"]);
});

test("the cd wrapper really starts the command in that folder", async () => {
  const { execFileSync } = await import("node:child_process");
  const argv = splitArgv({ argv: ["pwd"], cwd: "/usr" });
  assert.equal(execFileSync(argv[0], argv.slice(1)).toString().trim(), "/usr");
  const missing = splitArgv({ argv: ["sh", "-c", "echo ran"], cwd: "/no/such/folder" });
  assert.equal(execFileSync(missing[0], missing.slice(1)).toString().trim(), "ran");
});

test("names splits Herdr's where label", () => {
  assert.deepEqual(names("Aeo Product / t-0012 · Full build"), { space: "Aeo Product", tab: "t-0012 · Full build" });
  assert.deepEqual(names("a / b / c", "a / b"), { space: "a / b", tab: "c" });
  assert.equal(tabName("2"), "");
  assert.equal(tabName("fix login"), "fix login");
});

const rec = (address, tab, space, finished, created, extra = {}) => ({
  address, state: "finished", reason: "killed", finished_ms: finished, created_ms: created, cols: 100, rows: 40, argv: ["/bin/bash"], cwd: "/tmp",
  labels: { "herdr.tab": tab, "herdr.space": space, where: `S / ${tab}` }, ...extra,
});

test("closedTabs groups a tab's terminals and orders closes newest first", () => {
  const records = [
    rec("t1", "tbA", "sp1", 1000, 10),
    rec("t2", "tbB", "sp1", 5000, 20),
    rec("t3", "tbB", "sp1", 5200, 30),
    rec("t4", "tbOpen", "sp1", 6000, 40),
    rec("t5", "tbC", "sp1", 7000, 50, { reason: "exited" }),
    rec("t6", "tbD", "sp1", 8000, 60, { labels: {} }),
    { ...rec("vps/t1", "tbR", "spR", 9000, 70) },
  ];
  const tabs = closedTabs(records, new Set(["tbOpen"]), new Set());
  assert.deepEqual(tabs.map((g) => g.tab), ["vps/tbR", "tbB", "tbA"]);
  assert.equal(tabs[0].space, "vps/spR");
  assert.equal(tabs[0].machine, "vps");
  assert.deepEqual(tabs[1].terminals.map((t) => t.address), ["t2", "t3"]);
  assert.deepEqual(closedTabs(records, new Set(), new Set(["vps/tbR", "tbB"])).map((g) => g.tab), ["tbOpen", "tbA"]);
});

test("a pane closed long before its tab stays closed", () => {
  const tabs = closedTabs([rec("t1", "tbA", "sp1", 100000, 10), rec("t2", "tbA", "sp1", 1000, 20)], new Set(), new Set());
  assert.deepEqual(tabs[0].terminals.map((t) => t.address), ["t1"]);
});

test("nextClose reopens into an open space, else the whole space closed together", () => {
  const tabs = closedTabs([rec("t1", "tbA", "sp1", 50000, 10), rec("t2", "tbB", "sp1", 50500, 20), rec("t3", "tbOld", "sp1", 1000, 5)], new Set(), new Set());
  const open = nextClose(tabs, new Set(["sp1"]));
  assert.equal(open.newSpace, false);
  assert.equal(open.space, "sp1");
  assert.deepEqual(open.tabs.map((g) => g.tab), ["tbB"]);
  const gone = nextClose(tabs, new Set());
  assert.equal(gone.newSpace, true);
  assert.deepEqual(gone.tabs.map((g) => g.tab), ["tbA", "tbB"]);
  const moved = nextClose(tabs, new Set(["spNew"]), { sp1: "spNew" });
  assert.equal(moved.space, "spNew");
  assert.equal(nextClose([], new Set()), null);
});

test("position puts a tab back before the first tab made after it", () => {
  const open = [{ created: 10 }, { created: null }, { created: 30 }];
  assert.equal(position(open, 20), 3);
  assert.equal(position(open, 5), 1);
  assert.equal(position(open, 40), null);
});

test("nextClose can be asked for one closed tab", () => {
  const tabs = closedTabs([rec("t1", "tbA", "sp1", 50000, 10), rec("t2", "tbB", "sp1", 60000, 20)], new Set(), new Set());
  assert.deepEqual(nextClose(tabs, new Set(["sp1"]), {}, "tbA").tabs.map((g) => g.tab), ["tbA"]);
  assert.equal(nextClose(tabs, new Set(["sp1"]), {}, "tbMissing"), null);
});

test("the ledger survives bad files and stays bounded", () => {
  assert.deepEqual(readLedger("not json"), { tabs: [], spaces: {}, born: {} });
  assert.deepEqual(readLedger(""), { tabs: [], spaces: {}, born: {} });
  let l = readLedger("{}");
  for (let i = 0; i < KEEP + 10; i++) l = addToLedger(l, { tabs: [`tb${i}`], spaces: { [`sp${i}`]: `new${i}` } });
  assert.equal(l.tabs.length, KEEP);
  assert.equal(l.tabs.at(-1), `tb${KEEP + 9}`);
  assert.equal(Object.keys(l.spaces).length, KEEP);
  assert.equal(l.spaces[`sp${KEEP + 9}`], `new${KEEP + 9}`);
});

test("describe tells an agent what would come back", () => {
  const [close] = closedTabs([
    rec("vps/t4", "tbX", "spX", 9000, 1, { argv: [...REMOTE, "claude", "fix it now"], cwd: "/srv/app", labels: { "herdr.tab": "tbX", "herdr.space": "spX", where: "App / 3" } }),
    rec("vps/t5", "tbX", "spX", 9100, 2, { cwd: "/srv/app/web", labels: { "herdr.tab": "tbX", "herdr.space": "spX", where: "App / 3" } }),
  ], new Set(), new Set());
  const d = describe(close);
  assert.equal(d.tab, "vps/tbX");
  assert.equal(d.machine, "vps");
  assert.equal(d.name, null);
  assert.equal(d.space_name, "App");
  assert.equal(d.closed_at, new Date(9100).toISOString());
  assert.deepEqual(d.panes, [
    { terminal: "vps/t4", folder: "/srv/app", command: ["claude", "--continue"] },
    { terminal: "vps/t5", folder: "/srv/app/web", command: null },
  ]);
});

test("a pane reopened before is not wrapped twice", () => {
  const once = splitArgv({ argv: ["/bin/bash"], cwd: "/etc" });
  // Core records the split's folder as the pane it split, not where the wrapper went.
  const again = splitArgv({ argv: once, cwd: "/usr/share" });
  assert.deepEqual(again, once);
  assert.deepEqual(start({ argv: once, cwd: "/usr/share" }), { folder: "/etc", argv: ["/bin/bash"] });
  const agent = splitArgv({ argv: [...WRAP, "claude"], cwd: "/src" });
  assert.deepEqual(splitArgv({ argv: agent, cwd: "/" }), agent);
  assert.deepEqual(tabArgv({ argv: agent, cwd: "/" }), ["claude", "--continue"]);
});

test("a reopened tab keeps the age it was first made at", () => {
  const records = [rec("t9", "tbNew", "sp1", 5000, 900), rec("t1", "tbOld", "sp1", 5000, 100)];
  const plain = closedTabs(records, new Set(), new Set());
  assert.equal(plain.find((g) => g.tab === "tbNew").created, 900);
  const kept = closedTabs(records, new Set(), new Set(), { tbNew: 50 });
  assert.equal(kept.find((g) => g.tab === "tbNew").created, 50);
  assert.deepEqual(nextClose(kept, new Set()).tabs.map((g) => g.tab), ["tbNew", "tbOld"]);
  assert.deepEqual(addToLedger(readLedger("{}"), { born: { tbNew: 50 } }).born, { tbNew: 50 });
});

test("names come from the pane that died first, not one Herdr re-adopted while it died", () => {
  const where = (w) => ({ labels: { "herdr.tab": "tbC", "herdr.space": "sp1", where: w } });
  const tabs = closedTabs([
    rec("t1", "tbC", "sp1", 5000, 10, where("proj / build")),
    rec("t2", "tbC", "sp1", 6400, 20, where("usr / 1")),
    rec("t3", "tbD", "sp1", 6600, 5, { labels: { "herdr.tab": "tbD", "herdr.space": "sp1", where: "usr / 2" } }),
    rec("t4", "tbE", "sp1", 4900, 30, { labels: { "herdr.tab": "tbE", "herdr.space": "sp1", where: "proj / 3" } }),
  ], new Set(), new Set());
  assert.equal(tabs.find((g) => g.tab === "tbC").where, "proj / build");
  const plan = nextClose(tabs, new Set());
  assert.deepEqual(plan.tabs.map((g) => g.tab), ["tbD", "tbC", "tbE"]);
  assert.equal(plan.where, "proj / 3");
});
