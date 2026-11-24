# Premiere MCP Bridge

Lets Claude Code edit a live Adobe Premiere Pro project while you watch: cuts, trims, effects, Lumetri colour, transitions, audio fades, text and captions, markers, scene detection, transcription, export and interchange.

Install: see [INSTALL.md](INSTALL.md).

## How it works

```
Claude Code ──stdio──> mcp/pr-mcp.js ──WebSocket 127.0.0.1:7790──> panel (UXP plugin in Premiere)
```

- `mcp/pr-mcp.js`: MCP server. Node built-ins only, no `npm install`.
- `panel/`: UXP panel that runs the edits through the Premiere API.
- `skills/`: Claude Code skills: `premiere-mcp-bridge` (workflow), `premiere-color` (grading), `premiere-deliver` (export).
- `docs/premiere-27-api.md`: map of the Premiere 27 UXP API and its quirks.

## Safety

- The server listens on 127.0.0.1 only. A random token in `~/.pr-mcp-bridge.json` and an Origin check stop web pages from connecting.
- Writes go only to the project you mark as the sandbox in the panel.
- Each write is one undo step named "MCP: …" (Ctrl+Z / Cmd+Z).
- `pr_eval` (raw scripts) is off until you tick it in the panel.
- `pr_export` refuses to start when free RAM is low.

## Platform notes

- Tested on Premiere Pro 27.0 on Windows, including the agent install. The macOS install, paths and text renderer are written but not yet tested on a Mac.
- Text and captions are rendered as transparent PNGs (PowerShell GDI+ on Windows, AppKit via `osascript` on macOS), because the API cannot set MOGRT text.
- No API reaches Premiere 27 Color Mode; grading uses Lumetri Color.
- Export always renders the whole sequence (the work area is ignored).

## Env vars

`PR_BRIDGE_PORT` (default 7790), `PR_BRIDGE_TOKEN` (fixed token), `PR_BRIDGE_MAX_PX` (frame preview size, default 1024).

## License

MIT, see [LICENSE](LICENSE).
