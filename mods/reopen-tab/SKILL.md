---
name: herdr-reopen-tab
description: Reopen tabs closed in the Herdr desktop app (what Cmd+Shift+T does), or list what can come back, through the reopen-tab mod's local MCP tools, JSON API or CLI.
---

# Reopen closed tab (Herdr mod)

Cmd+Shift+T for the Herdr desktop app: brings back the tab closed last, in its
place in its space, with its panes in their folders and agents (Claude Code,
Codex) resuming their last conversation there. Press again for the one before.
A closed space comes back whole; tabs on other machines come back there.

| Action | JSON API | MCP tool | CLI |
|---|---|---|---|
| see what Cmd+Shift+T brings back, No closed tab to reopen | GET /v1/closed-tabs | herdr_closed_tabs_list | `herdr-reopen-tab list` |
| Cmd+Shift+T | POST /v1/reopen | herdr_closed_tab_reopen | `herdr-reopen-tab reopen` |

Run with Node 18+: `node ~/.config/herdr-app/mods/reopen-tab/agent.mjs` (MCP stdio,
protocol 2025-11-25), `node .../agent.mjs --http 0` (loopback JSON API: prints its
URL; `GET /v1/tools` lists the same schemas; send `Accept: text/markdown` for
Markdown), or the CLI `herdr-reopen-tab list|reopen [--tab ID] [--md]` (install.sh
links it into ~/.local/bin). Answers are JSON; MCP results carry JSON and Markdown.
HTTP POST bodies are JSON arguments from the tool schemas below.
Herdr's window must be open with the mod installed. HERDR_APP_HOME picks another app
home (XDG_CONFIG_HOME is respected), HERDR_APP_BIN the app's CLI; herdr-core is
found the way the app finds it (settings.json `core`, PATH, usual places).

Closed tabs come from herdr-core's records of finished terminals (`hc ls --all`,
`hc get`), so nothing watches while you work. A reopen runs inside Herdr, exactly
as the key does: the adapter writes data/reopen-tab/request.json, runs
`herdr-app do mod.open '{"name":"reopen-tab"}'`, and reads data/reopen-tab/result.json.
`next` in the list is what the key (or a reopen without `tab`) brings back.

Use tab ids from the list, with any machine prefix (`vps/tb…`), not names or
positions. Each close comes back once, and the reopened tab gets focus. Check tool
errors; do not open, restart or close Herdr or any terminal to make one work.
After a reopen, list again or run `herdr-app ls` to confirm.

What comes back: each pane's command and the folder it started in (not one it
`cd`-ed to later); claude reruns with --continue and codex with resume --last,
without resending a first task; other programs rerun as they were. Panes come back
side by side with even widths (herdr-core does not keep split shapes). Mod panes
(no terminal) and panes closed earlier in the tab don't come back. Names come
from Herdr's `where` label; a tab nobody named comes back unnamed.

Agent prompt: "List my recently closed Herdr tabs with herdr_closed_tabs_list and
show me their names, spaces and when they closed. When I pick one, reopen it with
herdr_closed_tab_reopen and its exact tab id (no id reopens the newest), then
report the new tab id and what each pane runs. Do not close, restart or rename
anything else."

Read [llms-full.txt](llms-full.txt) for the generated argument schemas.
