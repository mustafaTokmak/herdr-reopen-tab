#!/bin/sh
# Installs the reopen-tab mod into the Herdr desktop app: the mod folder, its key
# (merged into your keys.json without replacing any key you use), and the agent CLI
# `herdr-reopen-tab` in ~/.local/bin. Run it again to update.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
app=$(command -v herdr-app || true)
for c in "$HOME/.local/bin/herdr-app" /Applications/Herdr.app/Contents/MacOS/Herdr; do
  if [ -z "$app" ] && [ -x "$c" ]; then app=$c; fi
done
if [ -z "$app" ]; then echo "The Herdr desktop app is needed (herdr.dev). Open it once, then run this again." >&2; exit 1; fi
config=${HERDR_APP_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-app}
if [ ! -d "$config" ]; then echo "Open Herdr once first, so $config exists." >&2; exit 1; fi
dest=$config/mods/reopen-tab
if [ -e "$dest" ] && ! grep -q herdr_closed_tab_reopen "$dest/agent-tools.json" 2>/dev/null; then
  echo "$dest is another mod. Nothing was changed." >&2; exit 1
fi

"$app" check "$src/mods/reopen-tab"
mkdir -p "$dest"
for f in main.js plan.js mod.json package.json agent.mjs agent-tools.json SKILL.md llms.txt llms-full.txt; do
  cp "$src/mods/reopen-tab/$f" "$dest/$f"
done
chmod +x "$dest/agent.mjs"
echo "Installed the mod in $dest"

# Merge keys.json: add our keys; never replace one you already use.
merge='
const fs = require("fs");
const [file, ours] = process.argv.slice(1);
const mine = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const add = JSON.parse(fs.readFileSync(ours, "utf8"));
for (const [section, keys] of Object.entries(add)) {
  mine[section] ||= {};
  for (const [key, action] of Object.entries(keys)) {
    const now = mine[section][key];
    if (now === undefined) { mine[section][key] = action; console.log(`Bound ${key} to ${action}`); }
    else if (now !== action) console.log(`${key} is already ${now}: bind ${action} to a free key in ${file} yourself`);
  }
}
fs.writeFileSync(file, JSON.stringify(mine, null, 2) + "\n");
'
if command -v node >/dev/null 2>&1; then
  node -e "$merge" "$config/keys.json" "$src/keys.json"
else
  echo "No node here: add \"cmd-shift-t\": \"mod.open:reopen-tab\" to \"global\" in $config/keys.json"
fi

# The agent CLI and MCP server (needs Node 18+).
if command -v node >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  link=$HOME/.local/bin/herdr-reopen-tab
  if [ ! -e "$link" ] || [ -L "$link" ]; then
    ln -sf "$dest/agent.mjs" "$link"
    echo "Agent CLI: herdr-reopen-tab list | reopen [--tab ID]  (JSON; --md for Markdown)"
  else
    echo "$link exists and isn't ours; run node \"$dest/agent.mjs\" instead"
  fi
  echo "MCP for Claude Code: claude mcp add herdr-reopen-tab -- node \"$dest/agent.mjs\""
  echo "MCP for Codex:       codex mcp add herdr-reopen-tab -- node \"$dest/agent.mjs\""
else
  echo "Install Node 18+ for the agent CLI and MCP server (the key works without it)."
fi
echo "Close a tab, then press Cmd+Shift+T (Super+Shift+T on Linux and Windows)."
