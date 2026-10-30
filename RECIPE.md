# Reopen closed tab

Cmd+Shift+T for the Herdr desktop app, like a browser's: it brings back the tab you closed last, where it was in its space, with its name and its panes in their folders, and agents (Claude Code, Codex) pick up their last conversation there. Press again for the close before that. A closed space comes back whole, and a tab on another machine comes back on that machine. A small popup under the tab bar says what is coming back while it works.

![Reopen closed tab](preview.png)

## What you see

- Nothing until you press Cmd+Shift+T (Super+Shift+T on Linux and Windows).
- Then a popup pill, 360×40 px, centered at the top of the window 44 px down (just under the tab bar): the theme's popover background, 1 px border in the border color, 10 px corner radius, 14 px side padding. Inside, 10 px apart: a 12 px braille spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 80 ms a frame) in the accent color, and 13 px text in the foreground color, cut off with an ellipsis: "Looking for a closed tab…", then "Reopening web…" or "Reopening 3 tabs of shop…". It closes by itself when the tab is back, usually within a second.
- The tab appears in its old place in the tab bar, selected, with its first pane focused.
- Nothing closed: an info toast "No closed tab to reopen" for 2.5 s. A failure: an error toast "Couldn't reopen the tab" with the reason.

## How it behaves

- Each press brings back the newest close not yet brought back, like a browser, up to the last 25. Each close comes back once. Pressing again while the popup is still working takes the close after it.
- If the tab's space is open, the tab comes back into it, placed before the first open tab that was made after it. If the space closed too, the space comes back, with every tab that closed along with it (within 15 s), in their old order. Its name comes back too, unless it was named after its folder or git repo; in that case it comes back unnamed, as it was. Its machine is the same one.
- Every terminal pane comes back running the same command, in the folder it started in. The first one opens with the tab; the others split to the right of it, with even widths.
  - `claude` gets `--continue`, and `codex` becomes `codex resume --last`. Either way the first task Herdr gave it is not sent again.
  - A command that already names a session (`--resume`, `codex resume …`), a one-shot run (`-p`, `--print`) and a subcommand (`claude doctor`) rerun exactly as they were. So do other programs.
  - A plain shell comes back as a shell.
- If the folder is gone, the tab starts in its space's folder.
- Agent statuses (working, blocked, done, idle): the popup doesn't show any. Reopened agents report their status to Herdr like any other.
- No clicks or hovers: the popup takes no input.
- Agents can do the same as the key, and also see what can come back:
  - `herdr_closed_tabs_list` (`GET /v1/closed-tabs`, `herdr-reopen-tab list`);
  - `herdr_closed_tab_reopen {tab?}` (`POST /v1/reopen`, `herdr-reopen-tab reopen [--tab ID]`).

## Built from

- `mods/reopen-tab/mod.json`: `{"place":"none","title":"Reopen closed tab","overlay":{"kind":"popup","at":"top","offset":44,"width":360,"height":40,"frame":"none"}}`. It is not a pane or a layout block: `mod.open:reopen-tab` opens it as that popup.
- `keys.json`: `{"global":{"cmd-shift-t":"mod.open:reopen-tab"}}`.
- `main.js` is the popup view. Its `init` does the whole reopen in `cx.spawn`, writes the answer, and always ends with `closeOverlay(props().overlay)`. It uses these `herdr` functions: `hc`, `exec`, `spaces`, `panes`, `terminals`, `theme`, `props`, `run`, `closeOverlay`, `notify`, `appHome`, `readTextFile`, plus `fs/promises`. Its `render` is `h_flex` with a `div().frames(SPIN, 80)` spinner and a `truncate()` label.
- **What closed** comes from herdr-core's records of finished terminals. `hc ls --all --json` lists them; it keeps those with `reason` `killed` and a `where` label. `hc get <address> --json` (16 at a time) adds `argv`, `cwd`, `created_ms`, `finished_ms` and the labels `herdr.space`, `herdr.tab` and `where` ("Space / Tab"). Ids are qualified with the machine (`vps/tb…`) as the app shows them. The records are grouped by tab, and tabs Herdr still shows are skipped.
- **Commands it runs:**
  - `tab.new {space, name, folder, argv}`;
  - `space.new {name, folder, tab, argv, machine}`;
  - `pane.split {pane, direction: "right", argv}`;
  - `layout.resize {id, weight: 1}`;
  - `tab.move {id, index}`;
  - `space.select`, `tab.select` and `pane.focus`.

  `run` applies after the script yields, so it polls `spaces()`/`panes()` every 25 ms (for up to 8 s) for each result.
- **Programs it runs:**
  - `hc ls` and `hc get` (read only);
  - `sh -c 'test -d "$1"'` on the tab's machine, to check the folder still exists;
  - `git rev-parse --show-toplevel`, to tell whether the space was named after its repo.

  It never reaches the network.
- **Files:** only its own `data/reopen-tab/`:
  - `ledger.json`: tabs already reopened, old to new space ids, and when each reopened tab was first made, 200 entries each;
  - `request.json` and `result.json`: the agent handshake.
- `plan.js` holds the logic as pure functions, with no `herdr` imports, so `node --test` checks it: unwrapping commands, resume rules, grouping closes, picking the next one, placing it.
- `agent.mjs` and `agent-tools.json` are the agent side, run with Node (the mod never starts it):
  - an MCP stdio server;
  - `--http PORT`, a loopback JSON API that refuses browser origins;
  - a CLI.

  A reopen from an agent writes `request.json` (id, tab, time), runs `herdr-app do mod.open '{"name":"reopen-tab"}'` and waits for a `result.json` with the same id. `scripts/agent-docs.mjs` generates `llms.txt`, `llms-full.txt` and `SKILL.md` from `agent-tools.json`.

## Watch out

- `pane.split` runs its argv as given, in the folder of the pane it splits, and takes no folder. So each extra pane runs `sh -c 'cd -- "$1" 2>/dev/null; shift; [ $# -gt 0 ] && exec "$@"; exec "${SHELL:-sh}" -i' sh <folder> <argv…>`.
  - Take that wrapper off again when reading a pane that was reopened before. If you don't, it nests a level deeper on every close.
  - No wrapper is used on Windows.
- `tab.new` and `space.new` wrap an agent in Herdr's shell, `[shell, -ic, '"$@"; exec "$0" -i', shell, …cmd]`. Fish and other machines use their own script of the same shape. The records show that wrapper, so unwrap it before passing the command back, or it doubles.
- Herdr adds the first task as the last argument; drop it when resuming.
- herdr-core's finished records give every pane 200×120, so a tab's split shape is lost. Panes come back side by side, evenly.
- Records keep the folder a pane started in, not one it `cd`-ed to later.
- Herdr takes a closed tab out of its model first and kills its terminals after.
  - A terminal that takes a while to die is re-adopted as a ghost tab and relabeled: `where` becomes "Space / 7", or a new space named after its folder. So take names from the pane that died first.
  - While the ghost is up (about a second for a stubborn agent), the tab still counts as open, so a press right then brings back the close before it.
  - A single-pane tab whose agent dies slowly can come back unnamed.
- A reopened tab gets a new id and a new creation time. Keep its first-made time (ledger `born`), or repeated closes shuffle the order.
- These don't come back:
  - mod panes, since they have no terminal and no record;
  - a pane closed more than 15 s before its tab;
  - a tab whose programs exited by themselves (only `killed` counts);
  - a pane whose finished record was removed (`hc rm`).
- Names come only from Herdr's `where` label. A tab nobody named (shown as "1", "2") comes back unnamed.
- Shipped layouts don't run a mod in the background, so nothing watches between presses. Everything is read from the core at press time, which took under half a second in testing.
- On Linux and Windows, `ctrl-shift-t` is already Herdr's new tab, and `cmd-shift-t` means Super+Shift+T, which some desktops take for themselves. In that case, bind `mod.open:reopen-tab` to a free key such as `alt-shift-t`.
- Built and tested with the Herdr app 0.1.9 and herdr-core 0.1.14 on Linux (an isolated app home, core session and X display). It has not been tried on a Mac yet.

## Done when

- `herdr-app check mods/reopen-tab` passes.
- `npm test` passes (26 tests). They include the check that every key and `mod.open` has an MCP tool, a JSON API route and a CLI command, and the check that `llms.txt`, `llms-full.txt` and `SKILL.md` match `agent-tools.json`.
- Close the middle tab of three: two panes, `claude "fix login"` and a shell in `/etc`. Press Cmd+Shift+T. It comes back:
  - second, named as before;
  - with claude run as `claude --continue` and the task not sent again;
  - with the shell in `/etc` beside it;
  - with the first pane focused.
- Close a space of three tabs, then press. The space comes back with its name and its three tabs in order. Codex runs `codex resume --last` once, not twice.
- Close a tab on another machine, then press. It comes back on that machine, in its folder there.
- Close two tabs and press twice quickly: both come back. Press with nothing closed: the toast shows.
- `herdr-reopen-tab list` names the close and says what the key brings back next. `herdr-reopen-tab reopen --tab <older id>` brings back an older close in its place. The MCP `tools/list` shows both tools. `curl -H 'Origin: https://example.com' …/v1/closed-tabs` gets 403.
