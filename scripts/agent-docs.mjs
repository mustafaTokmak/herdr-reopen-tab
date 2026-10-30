// Writes llms.txt, llms-full.txt and SKILL.md from agent-tools.json, so they can't drift.
//   node scripts/agent-docs.mjs [--check]
import { readFile, writeFile } from "node:fs/promises";
import { tools } from "../mods/reopen-tab/agent.mjs";

const repo = new URL("../", import.meta.url);
const mod = new URL("mods/reopen-tab/", repo);
const table = tools.map((t) => `| ${t.uiActions.join(", ")} | ${t.http.method} ${t.http.path} | ${t.name} | \`herdr-reopen-tab ${t.cli}\` |`).join("\n");
const overview = `# Reopen closed tab (Herdr mod)

Cmd+Shift+T for the Herdr desktop app: brings back the tab closed last, in its
place in its space, with its panes in their folders and agents (Claude Code,
Codex) resuming their last conversation there. Press again for the one before.
A closed space comes back whole; tabs on other machines come back there.

| Action | JSON API | MCP tool | CLI |
|---|---|---|---|
${table}
`;
const workflow = `
Run with Node 18+: \`node ~/.config/herdr-app/mods/reopen-tab/agent.mjs\` (MCP stdio,
protocol 2025-11-25), \`node .../agent.mjs --http 0\` (loopback JSON API: prints its
URL; \`GET /v1/tools\` lists the same schemas; send \`Accept: text/markdown\` for
Markdown), or the CLI \`herdr-reopen-tab list|reopen [--tab ID] [--md]\` (install.sh
links it into ~/.local/bin). Answers are JSON; MCP results carry JSON and Markdown.
HTTP POST bodies are JSON arguments from the tool schemas below.
Herdr's window must be open with the mod installed. HERDR_APP_HOME picks another app
home (XDG_CONFIG_HOME is respected), HERDR_APP_BIN the app's CLI; herdr-core is
found the way the app finds it (settings.json \`core\`, PATH, usual places).

Closed tabs come from herdr-core's records of finished terminals (\`hc ls --all\`,
\`hc get\`), so nothing watches while you work. A reopen runs inside Herdr, exactly
as the key does: the adapter writes data/reopen-tab/request.json, runs
\`herdr-app do mod.open '{"name":"reopen-tab"}'\`, and reads data/reopen-tab/result.json.
\`next\` in the list is what the key (or a reopen without \`tab\`) brings back.

Use tab ids from the list, with any machine prefix (\`vps/tb…\`), not names or
positions. Each close comes back once, and the reopened tab gets focus. Check tool
errors; do not open, restart or close Herdr or any terminal to make one work.
After a reopen, list again or run \`herdr-app ls\` to confirm.

What comes back: each pane's command and the folder it started in (not one it
\`cd\`-ed to later); claude reruns with --continue and codex with resume --last,
without resending a first task; other programs rerun as they were. Panes come back
side by side with even widths (herdr-core does not keep split shapes). Mod panes
(no terminal) and panes closed earlier in the tab don't come back. Names come
from Herdr's \`where\` label; a tab nobody named comes back unnamed.

Agent prompt: "List my recently closed Herdr tabs with herdr_closed_tabs_list and
show me their names, spaces and when they closed. When I pick one, reopen it with
herdr_closed_tab_reopen and its exact tab id (no id reopens the newest), then
report the new tab id and what each pane runs. Do not close, restart or rename
anything else."
`;
const schemas = "\n## Tool schemas\n\n" + tools.map((t) => `### ${t.name}\n\n${t.description}\n\n\`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\`\n`).join("\n");
const skill = `---
name: herdr-reopen-tab
description: Reopen tabs closed in the Herdr desktop app (what Cmd+Shift+T does), or list what can come back, through the reopen-tab mod's local MCP tools, JSON API or CLI.
---

`;
const files = [
  [new URL("llms.txt", mod), overview + "\nSee [full API reference](llms-full.txt) and [agent workflow](SKILL.md).\n"],
  [new URL("llms-full.txt", mod), overview + workflow + schemas],
  [new URL("SKILL.md", mod), skill + overview + workflow + "\nRead [llms-full.txt](llms-full.txt) for the generated argument schemas.\n"],
  [new URL("llms.txt", repo), overview + "\nSee [full API reference](llms-full.txt), [agent workflow](mods/reopen-tab/SKILL.md) and [install recipe](RECIPE.md).\n"],
  [new URL("llms-full.txt", repo), overview + workflow + schemas],
];
for (const [url, text] of files) {
  if (process.argv.includes("--check")) {
    const now = await readFile(url, "utf8").catch(() => "");
    if (now.replace(/\r\n/g, "\n") !== text) throw new Error(`${url.pathname.slice(repo.pathname.length)} is stale; run node scripts/agent-docs.mjs`);
  } else await writeFile(url, text);
}
