# Install

Written so an agent (Claude Code) can do every step except the last one, which needs the user in Premiere.

Supports Windows 10/11 and macOS, with Premiere Pro 27.0 or newer and Creative Cloud.

## Agent steps

1. Check the tools: `node --version` (needs 18 or newer) and `git --version`.
   - If Node is missing on macOS, run `brew install node`. Without Homebrew, use the installer from nodejs.org.
   - If Node is missing on Windows, run `winget install OpenJS.NodeJS.LTS`.
   - If git is missing on macOS, run `xcode-select --install`. On Windows, run `winget install Git.Git`.
2. Clone the repo to a folder that stays, because the MCP server runs from it:
   `git clone <repo-url> ~/tools/premiere-mcp`
3. Run the installer from the repo folder: `node scripts/install.js`
   The installer:
   - copies the skills to `~/.claude/skills` (it keeps existing ones; add `--force` to overwrite them)
   - registers the MCP server `premiere-pro` at user scope
   - builds `dist/premiere-mcp-bridge.ccx`
   - installs that package into Premiere with Adobe's Unified Plugin Installer Agent, which ships with Creative Cloud
4. Read the installer output:
   - If it says `claude CLI not found`, run the `claude mcp add …` command it prints.
   - If it says `panel install failed` or `installer not found`, ask the user to double-click `dist/premiere-mcp-bridge.ccx`.
5. Tell the user to restart Claude Code, or run `/mcp` and reconnect `premiere-pro`.

## User step (in Premiere)

1. Restart Premiere if it was open.
2. Open **Window ▸ UXP Plugins ▸ Premiere MCP Bridge**.
3. Open the project to edit and click **Use current project as sandbox**.

The panel connects by itself. There is no key to paste, because the panel reads the token from `~/.pr-mcp-bridge.json`. To check the connection, ask Claude to run `pr_status`.

Optional: tick **Allow raw scripts (pr_eval)** only if you want Claude to run raw UXP code.

## Update

The agent runs `git pull`, then `node scripts/install.js`. The user then restarts Premiere and reconnects with `/mcp`.

## Uninstall

1. Run `claude mcp remove premiere-pro -s user`.
2. Remove the plugin with UPIA. On Windows use `/remove "Premiere MCP Bridge"`; on macOS use `--remove "Premiere MCP Bridge"`. The UPIA path is in `scripts/install.js`.
3. Delete the `premiere-*` folders in `~/.claude/skills`.

## Developers

To load from source instead of installing the package, use UXP Developer Tools: **Add Plugin**, pick `panel/manifest.json`, then **Load**. Run `node scripts/install.js --no-panel` to skip the package install. Do not keep both loaded at once, because they share one plugin ID.
