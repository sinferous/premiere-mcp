#!/usr/bin/env node
/* Premiere MCP Bridge installer (Windows and macOS). No dependencies.
   1. Copies the skills in ./skills to ~/.claude/skills.
   2. Registers the MCP server with Claude Code (user scope) if the `claude` CLI is on PATH.
   3. Builds dist/premiere-mcp-bridge.ccx and installs it with Adobe's UPIA CLI (Windows and macOS).
   The only user step left: open the panel in Premiere and mark the sandbox project. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'mcp', 'pr-mcp.js');
const log = (s) => process.stdout.write(s + '\n');

function copySkills() {
  const src = path.join(ROOT, 'skills');
  const dst = path.join(os.homedir(), '.claude', 'skills');
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name, 'SKILL.md');
    if (!fs.existsSync(from)) { continue; }
    const to = path.join(dst, name);
    if (fs.existsSync(path.join(to, 'SKILL.md')) && !process.argv.includes('--force')) {
      log('skill ' + name + ': already installed, kept (use --force to overwrite)');
      continue;
    }
    fs.mkdirSync(to, { recursive: true });
    fs.copyFileSync(from, path.join(to, 'SKILL.md'));
    log('skill ' + name + ': installed');
  }
}

function registerMcp() {
  // One command string through the shell (claude is a .cmd shim on Windows).
  const sh = (line) => spawnSync(line, { encoding: 'utf8', shell: true, timeout: 60000 });
  const cmd = 'claude mcp add premiere-pro -s user -- node "' + SERVER + '"';
  if (sh(process.platform === 'win32' ? 'where claude' : 'command -v claude').status !== 0) { log('claude CLI not found. Register the server yourself:\n  ' + cmd); return; }
  if (/premiere-pro/.test(sh('claude mcp list').stdout || '')) { log('mcp premiere-pro: already registered'); return; }
  const r = sh(cmd);
  log(r.status === 0 ? 'mcp premiere-pro: registered' : 'mcp register failed, run:\n  ' + cmd + '\n' + (r.stderr || ''));
}

function buildCcx() {
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, 'premiere-mcp-bridge.ccx');
  try { fs.unlinkSync(out); } catch (e) { /* none */ }
  const panel = path.join(ROOT, 'panel');
  if (process.platform === 'win32') {
    const zip = out.replace(/\.ccx$/, '.zip');
    try { fs.unlinkSync(zip); } catch (e) { /* none */ }
    execFileSync('powershell.exe', ['-NoProfile', '-Command', "Compress-Archive -Path '" + panel + "\\*' -DestinationPath '" + zip + "'"]);
    fs.renameSync(zip, out);
  } else {
    execFileSync('zip', ['-qr', out, '.'], { cwd: panel });
  }
  log('panel package: ' + out);
  return out;
}

/* Install the .ccx with Adobe's Unified Plugin Installer Agent (ships with Creative Cloud). No UI, no UXP Developer Tools. */
const UPIA = process.platform === 'darwin'
  ? '/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent'
  : 'C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe';
function installPanel(ccx) {
  if (!fs.existsSync(UPIA)) { log('Adobe plugin installer not found (is Creative Cloud installed?). Double-click ' + ccx + ' instead.'); return false; }
  const flag = process.platform === 'darwin' ? '--install' : '/install';
  const r = spawnSync(UPIA, [flag, ccx], { encoding: 'utf8', timeout: 120000 });
  const text = (r.stdout || '') + (r.stderr || '');
  const ok = /Installation Successful/i.test(text);
  log(ok ? 'panel: installed in Premiere' : 'panel install failed:\n' + text.trim());
  return ok;
}

const [major] = process.versions.node.split('.').map(Number);
if (major < 18) { log('Node 18 or newer is needed. You have ' + process.versions.node + '.'); process.exit(1); }
copySkills();
registerMcp();
const ccx = buildCcx();
const panelOk = process.argv.includes('--no-panel') ? false : installPanel(ccx);
log('\nUser step: ' + (panelOk ? '' : 'install the panel (double-click the .ccx), then ') +
  'restart Premiere, open Window > UXP Plugins > Premiere MCP Bridge, and click "Use current project as sandbox".' +
  '\nAgent step: restart Claude Code or run /mcp to connect premiere-pro.');
