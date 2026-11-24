/*
 * Premiere MCP Bridge — UXP panel.
 * Connects to the MCP server's WebSocket on 127.0.0.1, authenticates with the
 * pairing token, and runs each tool call against the premierepro API.
 * Every write is one Premiere undo step labelled "MCP: …".
 */
'use strict';

const ppro = require('premierepro');
const PORT = 7790;
const TPS = 254016000000; // Premiere ticks per second

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { const v = localStorage.getItem('prmcp.' + k); return v === null ? d : v; },
  set: (k, v) => localStorage.setItem('prmcp.' + k, v)
};

function log(line) {
  const el = $('log');
  const t = new Date().toTimeString().slice(0, 8);
  el.textContent = (t + ' ' + line + '\n' + el.textContent).slice(0, 6000);
}
function setStatus(text, cls) { const s = $('status'); s.textContent = text; s.className = cls || ''; }

$('guard').checked = store.get('guard', '1') === '1';
$('raw').checked = store.get('raw', '0') === '1';
$('sandbox').textContent = 'Sandbox: ' + (store.get('sandbox', '') || 'none');

$('guard').addEventListener('change', () => { store.set('guard', $('guard').checked ? '1' : '0'); sendInfo(); });
$('raw').addEventListener('change', () => { store.set('raw', $('raw').checked ? '1' : '0'); sendInfo(); });
$('setSandbox').addEventListener('click', async () => {
  try {
    const p = await ppro.Project.getActiveProject();
    if (!p || !p.path) { throw new Error('Open and save a project first.'); }
    store.set('sandbox', p.path);
    $('sandbox').textContent = 'Sandbox: ' + p.path;
    log('sandbox set: ' + p.name);
    sendInfo();
  } catch (e) { log('sandbox: ' + e.message); }
});

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

let ws = null;
let retryTimer = null;

async function panelInfo() {
  let project = null;
  try { const p = await ppro.Project.getActiveProject(); project = p ? { name: p.name, path: p.path } : null; } catch (e) { /* none */ }
  let host = null;
  try { const h = require('uxp').host; host = h.name + ' ' + h.version; } catch (e) { /* unknown */ }
  return { host, project, sandbox: store.get('sandbox', '') || null,
           guard: store.get('guard', '1') === '1', raw: store.get('raw', '0') === '1', panel: '0.2.0' };
}
async function sendInfo() { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'info', info: await panelInfo() })); } }

function reconnect() {
  clearTimeout(retryTimer);
  if (ws) { try { ws.onclose = null; ws.close(); } catch (e) { /* closed */ } ws = null; }
  connect();
}

/* The MCP server writes its token to ~/.pr-mcp-bridge.json. The panel reads it
   on every connect (manifest grants localFileSystem: fullAccess), so there is
   nothing to paste and a regenerated token is picked up on the next retry. */
function tokenPaths() {
  const out = [];
  try { const h = require('os').homedir(); if (h) { out.push(h.replace(/[\\/]+$/, '') + '/.pr-mcp-bridge.json'); } } catch (e) { /* no os */ }
  return out;
}
function readToken() {
  const fs = require('fs');
  for (const pth of tokenPaths()) {
    for (const cand of [pth, 'file:' + pth]) {
      try {
        const t = JSON.parse(fs.readFileSync(cand, { encoding: 'utf-8' })).token;
        if (t) { return t; }
      } catch (e) { /* try next */ }
    }
  }
  return null;
}

function connect() {
  const token = readToken();
  if (!token) {
    setStatus('Waiting for the MCP server (no token file yet)…', 'bad');
    retryTimer = setTimeout(connect, 3000);
    return;
  }
  setStatus('Connecting to 127.0.0.1:' + PORT + '…');
  try { ws = new WebSocket('ws://127.0.0.1:' + PORT); }
  catch (e) { setStatus('WebSocket error: ' + e.message, 'bad'); retryTimer = setTimeout(connect, 3000); return; }
  ws.onopen = async () => { ws.send(JSON.stringify({ type: 'hello', token, info: await panelInfo() })); };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'welcome') { setStatus('Connected to MCP server ' + msg.server, 'ok'); log('connected'); return; }
    if (msg.type === 'denied') { setStatus('Token mismatch, retrying…', 'bad'); return; }
    if (msg.id !== undefined) { handleCall(msg); }
  };
  ws.onerror = () => { /* onclose follows */ };
  ws.onclose = () => {
    setStatus('Waiting for the MCP server (start a Claude session)…', 'bad');
    retryTimer = setTimeout(connect, 2000);
  };
}

async function handleCall(msg) {
  const fn = HANDLERS[msg.fn];
  let out;
  try {
    if (!fn) { throw new Error('Unknown bridge function "' + msg.fn + '". Reload the panel to get the latest code.'); }
    const result = await fn(msg.args || {});
    out = { id: msg.id, ok: true, result: result === undefined ? null : result };
    log('ok ' + msg.fn);
  } catch (e) {
    out = { id: msg.id, ok: false, error: (e && e.message) || String(e) };
    log('ERR ' + msg.fn + ': ' + out.error);
  }
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(out)); }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function project() {
  const p = await ppro.Project.getActiveProject();
  if (!p) { throw new Error('No project is open in Premiere.'); }
  return p;
}

const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();

function assertWritable(p) {
  if (store.get('guard', '1') !== '1') { return; }
  const sb = store.get('sandbox', '');
  if (!sb) { throw new Error('Refused: no sandbox project is set. Ask the user to click "Use current project as sandbox" in the Premiere MCP Bridge panel.'); }
  if (norm(sb) !== norm(p.path)) { throw new Error('Refused: the open project is not the sandbox (' + sb + '). Ask the user to set this project as the sandbox, or switch projects.'); }
}

async function sequence(p, ref) {
  if (!ref) {
    const s = await p.getActiveSequence();
    if (!s) { throw new Error('No active sequence. Open one in the timeline or pass "sequence".'); }
    return s;
  }
  const all = await p.getSequences();
  const hit = all.find((s) => s.name === ref || String(s.guid) === ref) ||
              all.find((s) => String(s.name).toLowerCase() === String(ref).toLowerCase());
  if (!hit) { throw new Error('No sequence "' + ref + '". Sequences: ' + all.map((s) => s.name).join(', ')); }
  return hit;
}

async function tpfOf(seq) { return Number(await seq.getTimebase()); } // ticks per frame

/* Any time form → frame-aligned ticks. */
function toTicks(t, tpf) {
  const fps = TPS / tpf;
  if (typeof t === 'number') { return Math.round(t * fps) * tpf; }
  const s = String(t).trim();
  let m;
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)f$/))) { return Math.round(parseFloat(m[1])) * tpf; }
  if ((m = s.match(/^(\d+):(\d+):(\d+)[:;](\d+)$/))) {
    const nominal = Math.round(fps);
    return ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * nominal + +m[4]) * tpf;
  }
  if ((m = s.match(/^(-?\d+(?:\.\d+)?)s?$/))) { return Math.round(parseFloat(m[1]) * fps) * tpf; }
  throw new Error('Cannot read time "' + t + '". Use seconds, "75f" or "00:00:02:15".');
}
const tick = (ticks) => ppro.TickTime.createWithTicks(String(Math.round(ticks)));
const ticksOf = (tt) => Number(tt.ticks);

function trackRef(name) {
  const m = String(name || 'V1').trim().toUpperCase().match(/^([VA])(\d+)$/);
  if (!m) { throw new Error('Track must look like "V1" or "A2", got "' + name + '".'); }
  return { kind: m[1], index: parseInt(m[2], 10) - 1 };
}

async function getTrack(seq, ref) {
  const { kind, index } = trackRef(ref);
  const count = kind === 'V' ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
  if (index < 0 || index >= count) { return null; }
  return kind === 'V' ? seq.getVideoTrack(index) : seq.getAudioTrack(index);
}

async function trackClips(track) {
  const items = await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
  const rows = [];
  for (const it of items || []) { rows.push({ it, start: ticksOf(await it.getStartTime()) }); }
  rows.sort((a, b) => a.start - b.start);
  return rows.map((r) => r.it);
}

async function clipInfo(it, tpf, trackName, index) {
  const [name, s, e, i, o, dis] = await Promise.all([
    it.getName(), it.getStartTime(), it.getEndTime(), it.getInPoint(), it.getOutPoint(),
    it.isDisabled ? it.isDisabled() : false
  ]);
  let source = null;
  try { const pi = await it.getProjectItem(); source = pi ? pi.name : null; } catch (err) { /* none */ }
  const st = ticksOf(s), en = ticksOf(e);
  return {
    track: trackName, index, name, source,
    start: +(st / TPS).toFixed(4), end: +(en / TPS).toFixed(4),
    in: +(ticksOf(i) / TPS).toFixed(4), out: +(ticksOf(o) / TPS).toFixed(4),
    duration: +((en - st) / TPS).toFixed(4),
    startFrame: Math.round(st / tpf), endFrame: Math.round(en / tpf), disabled: !!dis
  };
}

async function findClip(seq, ref, tpf) {
  if (!ref || !ref.track) { throw new Error('A clip needs {track, index} or {track, at}.'); }
  const track = await getTrack(seq, ref.track);
  if (!track) { throw new Error('Track ' + ref.track + ' does not exist.'); }
  const clips = await trackClips(track);
  if (ref.index !== undefined) {
    const it = clips[ref.index - 1];
    if (!it) { throw new Error(ref.track + ' has ' + clips.length + ' clips; index ' + ref.index + ' is out of range.'); }
    return it;
  }
  if (ref.at !== undefined || ref.atTicks !== undefined) {
    const t = ref.atTicks !== undefined ? ref.atTicks : toTicks(ref.at, tpf);
    for (const it of clips) {
      const s = ticksOf(await it.getStartTime()), e = ticksOf(await it.getEndTime());
      if (t >= s && t < e) { return it; }
    }
    throw new Error('No clip on ' + ref.track + ' at ' + ref.at + '.');
  }
  throw new Error('A clip needs index or at.');
}

/* One undo step. build() runs inside the transaction and returns actions. */
function transact(p, label, build) {
  let ok = false, err = null;
  p.lockedAccess(() => {
    try {
      ok = p.executeTransaction((ca) => {
        for (const a of build()) { if (a) { ca.addAction(a); } }
      }, 'MCP: ' + label);
    } catch (e) { err = e; }
  });
  if (err) { throw err; }
  if (ok === false) { throw new Error('Premiere rejected the edit "' + label + '".'); }
}

/* Project panel walk. */
async function children(item) {
  for (const get of [
    () => item.getItems(),
    () => ppro.FolderItem.cast(item).getItems()
  ]) {
    try { const r = await get(); if (Array.isArray(r)) { return r; } } catch (e) { /* not a bin */ }
  }
  return null;
}

async function walk(p, visit, limit) {
  const root = await p.getRootItem();
  const stack = [{ item: root, path: '' }];
  let n = 0;
  while (stack.length && n < (limit || 5000)) {
    const { item, path } = stack.pop();
    const kids = await children(item);
    if (!kids) { continue; }
    for (const k of kids) {
      const kp = path ? path + '/' + k.name : k.name;
      const sub = await children(k);
      n++;
      if ((await visit(k, kp, !!sub)) === false) { return; }
      if (sub) { stack.push({ item: k, path: kp }); }
    }
  }
}

async function mediaPath(item) {
  try { const c = ppro.ClipProjectItem.cast(item); return await c.getMediaFilePath(); } catch (e) { return null; }
}

async function findItem(p, ref) {
  const want = norm(ref);
  let hit = null;
  const byName = [];
  await walk(p, async (k, kp, isBin) => {
    if (isBin) { return true; }
    if (norm(kp) === want) { hit = k; return false; }
    if (norm(k.name) === want) { byName.push(k); }
    if (want.includes('/') && want.includes(':')) {
      const mp = await mediaPath(k);
      if (mp && norm(mp) === want) { hit = k; return false; }
    }
    return true;
  });
  if (hit) { return hit; }
  if (byName.length === 1) { return byName[0]; }
  if (byName.length > 1) { throw new Error('"' + ref + '" matches ' + byName.length + ' items. Use the bin path, e.g. "Footage/' + ref + '".'); }
  throw new Error('No project item "' + ref + '". Use pr_list_items to find it.');
}

async function findBin(p, binPath) {
  if (!binPath) { return p.getRootItem(); }
  let hit = null;
  await walk(p, (k, kp, isBin) => { if (isBin && norm(kp) === norm(binPath)) { hit = k; return false; } return true; });
  if (!hit) { throw new Error('No bin "' + binPath + '". Create it in the Project panel first.'); }
  return hit;
}

/* Premiere 27.0 trim semantics (probed live 2026-11-24):
   - createSetInPointAction / createSetStartAction both trim the HEAD: in and start move together.
   - createSetOutPointAction / createSetEndAction both trim the TAIL: out and end move together.
   - createMoveAction(delta) shifts the clip by a RELATIVE amount, in/out unchanged.
   - Actions built in one transaction all see the clip's state from before the transaction,
     so dependent steps must each get their own transaction.
   fitClip runs in → out → move, each as its own undo step, reading the clip back between steps. */
async function clipTimes(it) {
  const [s, e, i, o] = await Promise.all([it.getStartTime(), it.getEndTime(), it.getInPoint(), it.getOutPoint()]);
  return { s: ticksOf(s), e: ticksOf(e), i: ticksOf(i), o: ticksOf(o) };
}
async function fitClip(p, it, tpf, want, label) {
  const close = (a, b) => Math.abs(a - b) < tpf / 2;
  let c = await clipTimes(it);
  if (want.inT !== undefined && want.inT !== null && !close(c.i, want.inT)) {
    transact(p, label + ': source in', () => [it.createSetInPointAction(tick(want.inT))]);
    c = await clipTimes(it);
  }
  if (want.len !== undefined && want.len !== null && !close(c.e - c.s, want.len)) {
    transact(p, label + ': length', () => [it.createSetOutPointAction(tick(c.i + want.len))]);
    c = await clipTimes(it);
  }
  if (want.at !== undefined && want.at !== null && !close(c.s, want.at)) {
    const d = want.at - c.s;
    transact(p, label + ': position', () => [it.createMoveAction(tick(d))]);
    c = await clipTimes(it);
  }
  return c;
}

/* The audio clip placed together with a video clip: same project item, same start, on audio track aIdx. */
async function linkedAudio(seq, aIdx, projItemName, startTicks, tpf) {
  if (aIdx === null || aIdx === undefined || aIdx >= await seq.getAudioTrackCount()) { return null; }
  const tr = await seq.getAudioTrack(aIdx);
  for (const it of await trackClips(tr)) {
    if (Math.abs(ticksOf(await it.getStartTime()) - startTicks) >= tpf / 2) { continue; }
    try { const pi = await it.getProjectItem(); if (pi && pi.name === projItemName) { return it; } } catch (e) { /* skip */ }
  }
  return null;
}

/* ---- Platform: Windows or macOS, any Premiere version folder ---- */
const IS_MAC = (() => { try { return require('os').platform() === 'darwin'; } catch (e) { return false; } })();
const SEP = IS_MAC ? '/' : '\\';
const joinP = (...parts) => parts.map((s, i) => (i ? String(s).replace(/^[\\/]+/, '') : String(s)).replace(/[\\/]+$/, '')).join(SEP);
/* Newest "Adobe Premiere Pro <year>" install folder, or null.
   Windows: C:\Program Files\Adobe\Adobe Premiere Pro 2027
   macOS:   /Applications/Adobe Premiere Pro 2027/Adobe Premiere Pro 2027.app/Contents */
let appRootCache;
function premiereAppRoot() {
  if (appRootCache !== undefined) { return appRootCache; }
  const fs = require('fs');
  const base = IS_MAC ? '/Applications' : 'C:\\Program Files\\Adobe';
  let names = []; try { names = fs.readdirSync(base).filter((n) => /^Adobe Premiere Pro/i.test(n)).sort().reverse(); } catch (e) { /* none */ }
  appRootCache = null;
  for (const n of names) {
    if (!IS_MAC) { appRootCache = joinP(base, n); break; }
    let apps = []; try { apps = fs.readdirSync(joinP(base, n)).filter((x) => /\.app$/i.test(x) && /Premiere/i.test(x)); } catch (e) { continue; }
    if (apps.length) { appRootCache = joinP(base, n, apps[0], 'Contents'); break; }
  }
  return appRootCache;
}

/* ---- MOGRT helpers ---- */
function listMogrts() {
  const fs = require('fs');
  const roots = [];
  try { roots.push(String(ppro.SequenceEditor.getInstalledMogrtPath())); } catch (e) { /* none */ }
  if (premiereAppRoot()) { roots.push(joinP(premiereAppRoot(), 'Essential Graphics')); }
  const out = [];
  const walkDir = (d, depth) => {
    let names = []; try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const n of names) {
      const f = joinP(d, n);
      if (/\.mogrt$/i.test(n)) { out.push(f); } else if (depth < 4 && !/\./.test(n)) { walkDir(f, depth + 1); }
    }
  };
  for (const r of roots) { walkDir(r, 0); }
  return out;
}
function resolveMogrt(name) {
  const x = name || 'Basic Title';
  if (/\.mogrt$/i.test(x) && /[\\/]/.test(x)) { return x; }
  const all = listMogrts();
  const k = x.toLowerCase().replace(/\.mogrt$/, '');
  const hit = all.find((f) => f.replace(/^.*[\\/]/, '').toLowerCase().replace(/\.mogrt$/, '') === k) || all.find((f) => f.toLowerCase().includes(k));
  if (!hit) { throw new Error('No template "' + x + '". Use pr_mogrts.'); }
  return hit;
}
/* Insert a MOGRT at time on a video track, set its length, then set the first text field (and font/size). */
async function placeText(p, seq, tpf, r) {
  const file = resolveMogrt(r.template);
  const vIdx = r.track ? trackRef(r.track).index : Math.max(1, (await seq.getVideoTrackCount()) - 1);
  const at = toTicks(r.at || 0, tpf);
  const ed = ppro.SequenceEditor.getEditor(seq);
  let made;
  p.lockedAccess(() => { made = ed.insertMogrtFromPath(file, tick(at), vIdx, 0); });
  made = await made;
  const it = Array.isArray(made) ? made[0] : made;
  if (!it) { throw new Error('Template insert failed on V' + (vIdx + 1) + ' (the spot may be taken).'); }
  if (r.duration) { transact(p, 'text length', () => [it.createSetEndAction(tick(at + toTicks(r.duration, tpf)))]); }
  const chain = await it.getComponentChain();
  let setText = false;
  for (let i = 0; i < chain.getComponentCount() && !setText; i++) {
    const c = chain.getComponentAtIndex(i);
    for (let j = 0; j < c.getParamCount() && !setText; j++) {
      const prm = c.getParam(j);
      let v; try { v = (await prm.getStartValue()).value; } catch (e) { continue; }
      if (typeof v !== 'string' || !/textEditValue/.test(v)) { continue; }
      const o = JSON.parse(v);
      o.textEditValue = String(r.text || '');
      if (r.font) { o.fontEditValue = [r.font]; }
      if (r.size) { o.fontSizeEditValue = [r.size]; }
      transact(p, 'text "' + String(r.text).slice(0, 20) + '"', () => [prm.createSetValueAction(prm.createKeyframe(JSON.stringify(o)), true)]);
      setText = true;
    }
  }
  return { text: r.text, at: +(at / TPS).toFixed(3), track: 'V' + (vIdx + 1), template: file.replace(/^.*[\\/]/, ''), textSet: setText };
}

/* ---- Export helpers ---- */
const presetRoot = () => (premiereAppRoot() ? joinP(premiereAppRoot(), 'MediaIO', 'systempresets') : null);
const PRESET_ALIAS = {
  'h264-high': '4E49434B_48323634\\01 - Match Source - High bitrate.epr',
  'h264-medium': '4E49434B_48323634\\01 - Match Source - Medium bitrate.epr',
  'h264-low': '4E49434B_48323634\\02 - Match Source - Low bitrate.epr',
  'hevc': '4A454646_48455643\\01 - Match Source - High Bitrate.epr',
  'prores-hq': '3F3F3F3F_4D6F6F56\\Apple ProRes 422 HQ.epr',
  'prores': '3F3F3F3F_4D6F6F56\\01 - Match Source.epr',
  'wav': '3F3F3F3F_57415645\\Waveform Audio 48kHz 16-bit.epr',
  'mp3': '3F3F3F3F_4D503320\\MP3 128kbps.epr',
  'aac': '4E49434B_41414320\\Stereo AAC, 44.1kHz 128kbps.epr',
  'png-seq': '3F3F3F3F_504E4720\\PNG Sequence (Match Source).epr',
  'gif': '47494666_47494666\\Animated GIF (Match Source).epr'
};
function resolvePreset(x) {
  if (/\.epr$/i.test(x)) { return x; }
  const k = String(x).toLowerCase();
  if (PRESET_ALIAS[k]) {
    if (!presetRoot()) { throw new Error('Premiere install folder not found; pass a full .epr path.'); }
    return joinP(presetRoot(), ...PRESET_ALIAS[k].split('\\'));
  }
  const hit = listPresets().find((f) => f.toLowerCase().includes(k));
  if (!hit) { throw new Error('No preset "' + x + '". Aliases: ' + Object.keys(PRESET_ALIAS).join(', ') + ', or use pr_export_presets.'); }
  return hit;
}
function presetExt(preset) {
  const f = preset.toLowerCase();
  if (f.includes('48323634') || f.includes('48455643')) { return 'mp4'; }
  if (f.includes('4d6f6f56')) { return 'mov'; }
  if (f.includes('wave')) { return 'wav'; }
  if (f.includes('mp3')) { return 'mp3'; }
  if (f.includes('aac')) { return 'aac'; }
  if (f.includes('png')) { return 'png'; }
  if (f.includes('gif')) { return 'gif'; }
  return 'mp4';
}
function listPresets() {
  const fs = require('fs');
  const out = [];
  const roots = presetRoot() ? [presetRoot()] : [];
  // User presets saved from Media Encoder (any version folder).
  try {
    const ame = joinP(require('os').homedir(), 'Documents', 'Adobe', 'Adobe Media Encoder');
    for (const v of fs.readdirSync(ame)) { roots.push(joinP(ame, v, 'Presets')); }
  } catch (e) { /* none */ }
  for (const r of roots) {
    let dirs = [];
    try { dirs = fs.readdirSync(r); } catch (e) { continue; }
    for (const d of dirs) {
      if (/\.epr$/i.test(d)) { out.push(joinP(r, d)); continue; }
      try { for (const f of fs.readdirSync(joinP(r, d))) { if (/\.epr$/i.test(f)) { out.push(joinP(r, d, f)); } } } catch (e) { /* file */ }
    }
  }
  return out;
}
/* Folder of a file path, with a trailing separator. Strips the Windows \\?\ long-path prefix Premiere reports. */
function winDir(file) {
  const f = String(file || '').replace(/^\\\\\?\\/, '');
  return IS_MAC ? f.replace(/[^/]*$/, '') : f.replace(/\//g, '\\').replace(/[^\\]*$/, '');
}
const exportLog = [];
let rendersWatched = false;
function watchRenders() {
  if (rendersWatched) { return; }
  rendersWatched = true;
  const E = ppro.EncoderManager;
  const on = (ev, name) => { try { E.addEventListener(ev, (e) => {
    const row = { at: new Date().toISOString(), event: name };
    try { for (const k of ['progress', 'result', 'error', 'outputFile', 'output', 'jobID']) { if (e && e[k] !== undefined) { row[k] = e[k]; } } } catch (x) { /* opaque */ }
    if (name === 'progress' && exportLog.length && exportLog[exportLog.length - 1].event === 'progress') { exportLog[exportLog.length - 1] = row; } else { exportLog.push(row); }
    if (exportLog.length > 200) { exportLog.splice(0, 100); }
  }); } catch (e) { /* event missing */ } };
  on(E.EVENT_RENDER_QUEUE, 'queued'); on(E.EVENT_RENDER_PROGRESS, 'progress');
  on(E.EVENT_RENDER_COMPLETE, 'complete'); on(E.EVENT_RENDER_ERROR, 'error'); on(E.EVENT_RENDER_CANCEL, 'cancel');
}

/* createCloneTrackItemAction(item, timeOffset, videoTrackOffset, audioTrackOffset, alignToVideo, isInsert) — probed 2026-11-24.
   Copies the clip (same in/out) to the track at +offset, shifted by timeOffset. */
function cloneAction(seq, it, dt, dv, da) {
  return ppro.SequenceEditor.getEditor(seq).createCloneTrackItemAction(it, tick(dt || 0), dv || 0, da || 0, true, false);
}

/* Clips of a track with times, sorted. */
async function trackRows(seq, name) {
  const tr = await getTrack(seq, name);
  if (!tr) { throw new Error('Track ' + name + ' does not exist.'); }
  const out = [];
  for (const it of await trackClips(tr)) { out.push(Object.assign({ it }, await clipTimes(it))); }
  return out;
}

/* Move a set of clips by dt without them colliding with each other: rightward moves go last-first. */
function moveMany(p, items, dt, label) {
  const order = dt > 0 ? items.slice().reverse() : items;
  for (const it of order) { transact(p, label, () => [it.createMoveAction(tick(dt))]); }
}

/* Remove a set of track items (TrackItemSelection API is thin; try known forms). */
async function removeItems(p, seq, items, ripple, label) {
  // TrackItemSelection.createEmptySelection() rejects no-arg and Sequence args in Premiere 27.0,
  // so use the sequence's live selection (clears the user's timeline selection).
  await seq.clearSelection();
  const sel = await seq.getSelection();
  for (const it of items) { await sel.addItem(it); }
  const editor = ppro.SequenceEditor.getEditor(seq);
  const MT = ppro.Constants.MediaType;
  const media = MT ? (MT.ANY !== undefined ? MT.ANY : MT.VIDEO) : undefined;
  transact(p, label, () => [editor.createRemoveItemsAction(sel, !!ripple, media, false)]);
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

async function seqSummary(s) {
  const tpf = await tpfOf(s);
  let size = null;
  try { const r = await s.getFrameSize(); size = r.width !== undefined ? [r.width, r.height] : [r.right - r.left, r.bottom - r.top]; } catch (e) { /* unknown */ }
  const end = await s.getEndTime();
  return {
    name: s.name, guid: String(s.guid), fps: +(TPS / tpf).toFixed(3), frameSize: size,
    duration: +(ticksOf(end) / TPS).toFixed(3),
    videoTracks: await s.getVideoTrackCount(), audioTracks: await s.getAudioTrackCount()
  };
}

const HANDLERS = {
  async project_info() {
    const p = await project();
    const seqs = await p.getSequences();
    const active = await p.getActiveSequence();
    const out = { name: p.name, path: p.path, sequences: [], active: active ? active.name : null, playhead: null };
    for (const s of seqs) { out.sequences.push(await seqSummary(s)); }
    if (active) { out.playhead = +(ticksOf(await active.getPlayerPosition()) / TPS).toFixed(4); }
    out.sandbox = store.get('sandbox', '') || null;
    out.writable = (() => { try { assertWritable(p); return true; } catch (e) { return false; } })();
    return out;
  },

  async sequence_tree(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const from = a.from !== undefined ? toTicks(a.from, tpf) : -Infinity;
    const to = a.to !== undefined ? toTicks(a.to, tpf) : Infinity;
    const want = a.tracks ? a.tracks.map((t) => t.toUpperCase()) : null;
    const out = { sequence: await seqSummary(seq), tracks: [], markers: [] };
    for (const kind of ['V', 'A']) {
      const n = kind === 'V' ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
      for (let i = 0; i < n; i++) {
        const name = kind + (i + 1);
        if (want && !want.includes(name)) { continue; }
        const track = kind === 'V' ? await seq.getVideoTrack(i) : await seq.getAudioTrack(i);
        const clips = await trackClips(track);
        const rows = [];
        for (let c = 0; c < clips.length; c++) {
          const info = await clipInfo(clips[c], tpf, name, c + 1);
          if (info.end * TPS > from && info.start * TPS < to) { rows.push(info); }
        }
        let muted = null; try { muted = await track.isMuted(); } catch (e) { /* n/a */ }
        out.tracks.push({ track: name, name: track.name, muted, clipCount: clips.length, clips: rows });
      }
    }
    out.markers = await listMarkers(seq, tpf);
    return out;
  },

  async list_items(a) {
    const p = await project();
    const q = a.query ? a.query.toLowerCase() : null;
    const inside = a.bin ? norm(a.bin) + '/' : null;
    const limit = a.limit || 300;
    const rows = [];
    await walk(p, async (k, kp, isBin) => {
      if (inside && !norm(kp).startsWith(inside)) { return true; }
      if (q && !String(k.name).toLowerCase().includes(q)) { return true; }
      const row = { name: k.name, path: kp, kind: isBin ? 'bin' : 'item' };
      if (!isBin) { const mp = await mediaPath(k); if (mp) { row.media = mp; } }
      rows.push(row);
      return rows.length < limit;
    });
    return { count: rows.length, items: rows };
  },

  async effects_catalog(a) {
    if (a.audio) {
      const n = await ppro.AudioFilterFactory.getDisplayNames();
      const q0 = a.query ? a.query.toLowerCase() : null;
      const rows = n.filter((x) => !q0 || String(x).toLowerCase().includes(q0));
      return { count: rows.length, audioEffects: rows };
    }
    const [m, d] = await Promise.all([ppro.VideoFilterFactory.getMatchNames(), ppro.VideoFilterFactory.getDisplayNames()]);
    const q = a.query ? a.query.toLowerCase() : null;
    const rows = m.map((x, i) => ({ matchName: x, name: d[i] }))
      .filter((r) => !q || r.matchName.toLowerCase().includes(q) || String(r.name).toLowerCase().includes(q));
    return { count: rows.length, effects: rows.slice(0, 400) };
  },

  async export_frames(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const sum = await seqSummary(seq);
    const [fw, fh] = sum.frameSize || [1920, 1080];
    let w, h;
    if (a.width) { w = Math.round(a.width); h = Math.round(fh * a.width / fw); }
    else { const k = Math.min(1, a.maxPx / Math.max(fw, fh)); w = Math.round(fw * k); h = Math.round(fh * k); }
    const frames = [];
    for (let i = 0; i < a.times.length; i++) {
      const t = toTicks(a.times[i], tpf);
      const file = a.prefix + '-' + i + '.png';
      let ok = false, error = null;
      try { ok = await ppro.Exporter.exportSequenceFrame(seq, tick(t), file, a.dir, w, h); }
      catch (e) { error = String((e && e.message) || e); }
      frames.push({ file, ok: ok !== false && !error, error, seconds: t / TPS, frame: Math.round(t / tpf), width: w, height: h });
    }
    return { frames };
  },

  async goto(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    try { await p.setActiveSequence(seq); } catch (e) { /* already */ }
    await seq.setPlayerPosition(tick(toTicks(a.time, tpf)));
    return { sequence: seq.name, playhead: +(ticksOf(await seq.getPlayerPosition()) / TPS).toFixed(4) };
  },

  async markers(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    if (a.action === 'list') { return { markers: await listMarkers(seq, tpf) }; }
    assertWritable(p);
    const M = await ppro.Markers.getMarkers(seq);
    if (a.action === 'add') {
      const list = a.markers || [];
      if (!list.length) { throw new Error('add needs markers: [{time, name, comment}]'); }
      transact(p, 'add ' + list.length + ' markers', () => list.map((m) =>
        M.createAddMarkerAction(m.name || '', m.type || 'Comment', tick(toTicks(m.time, tpf)),
          tick(m.duration !== undefined ? toTicks(m.duration, tpf) : 0), m.comment || '')));
      const colored = list.filter((m) => m.color !== undefined);
      if (colored.length) {
        const M2 = await ppro.Markers.getMarkers(seq);
        const all = M2.getMarkers();
        const hits = [];
        for (const m of colored) {
          const t = toTicks(m.time, tpf);
          const mk = all.find((x) => Math.abs(ticksOf(x.getStart()) - t) < tpf / 2 && x.getName() === (m.name || ''));
          if (mk) { hits.push([mk, colorIndex(m.color)]); }
        }
        // Action objects must be created inside lockedAccess, so build them in the transaction callback.
        if (hits.length) { transact(p, 'colour markers', () => hits.map(([mk, c]) => mk.createSetColorByIndexAction(c))); }
      }
      return { added: list.length, markers: await listMarkers(seq, tpf) };
    }
    const all = M.getMarkers();
    let victims;
    if (a.action === 'clear') {
      const re = a.match ? new RegExp(a.match) : null;
      victims = all.filter((m) => !re || re.test(m.getName()));
    } else {
      const ts = (a.times || []).map((t) => toTicks(t, tpf));
      const names = a.names || [];
      victims = all.filter((m) => names.includes(m.getName()) || ts.some((t) => Math.abs(ticksOf(m.getStart()) - t) < tpf / 2));
    }
    if (victims.length) { transact(p, 'remove ' + victims.length + ' markers', () => victims.map((m) => M.createRemoveMarkerAction(m))); }
    return { removed: victims.length, markers: await listMarkers(seq, tpf) };
  },

  async import(a) {
    const p = await project();
    assertWritable(p);
    const bin = await findBin(p, a.bin);
    const ok = await p.importFiles(a.files, true, bin, false);
    return { ok, files: a.files.length, bin: a.bin || '(root)' };
  },

  async place(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const editor = ppro.SequenceEditor.getEditor(seq);
    const audioCount = await seq.getAudioTrackCount();
    /* Reuse the first completely empty audio track; the API cannot delete tracks, so new ones would pile up. */
    let freeAudio = audioCount;
    for (let i = 0; i < audioCount; i++) {
      if (!(await trackClips(await seq.getAudioTrack(i))).length) { freeAudio = i; break; }
    }
    const prepared = [];
    for (const pl of a.placements) {
      const item = await findItem(p, pl.item);
      const v = trackRef(pl.track || 'V1');
      if (v.kind !== 'V') { throw new Error('placements[].track must be a video track (V1…). Use audioTrack for audio.'); }
      /* Default audio goes to an empty (or new) audio track, so music and dialogue are never overwritten. */
      const aIdx = pl.audioTrack ? trackRef(pl.audioTrack).index : freeAudio;
      prepared.push({ pl, item, at: toTicks(pl.at, tpf), v: v.index, aIdx, insert: pl.mode === 'insert' });
      if (!pl.force && !prepared[prepared.length - 1].insert) {
        const track = await getTrack(seq, 'V' + (v.index + 1));
        if (track) {
          for (const it of await trackClips(track)) {
            if (ticksOf(await it.getEndTime()) > prepared[prepared.length - 1].at && !prepared.slice(0, -1).length) {
              throw new Error('V' + (v.index + 1) + ' already has clips after ' + pl.at + '. Overwrite lays the full source length before trimming, ' +
                'so it could cover them. Use an empty track (e.g. V' + ((await seq.getVideoTrackCount()) + 1) + '), mode "insert", or force:true.');
            }
          }
        }
      }
    }
    /* Place and fit one clip at a time, so a full-length clip never collides with the next one's trims. */
    const result = [];
    for (const x of prepared) {
      const v = 'V' + (x.v + 1);
      transact(p, 'place ' + x.item.name + ' on ' + v, () => [x.insert
        ? editor.createInsertProjectItemAction(x.item, tick(x.at), x.v, x.aIdx, false)
        : editor.createOverwriteItemAction(x.item, tick(x.at), x.v, x.aIdx)]);
      const it = await findClip(seq, { track: v, atTicks: x.at }, tpf);
      const audio = await linkedAudio(seq, x.aIdx, x.item.name, x.at, tpf);
      const inT = x.pl.in !== undefined ? toTicks(x.pl.in, tpf) : null;
      const endT = x.pl.end !== undefined ? toTicks(x.pl.end, tpf)
        : x.pl.duration !== undefined ? x.at + toTicks(x.pl.duration, tpf) : null;
      if (inT !== null || endT !== null) {
        const want = { inT, len: endT !== null ? endT - x.at : null, at: x.at };
        await fitClip(p, it, tpf, want, 'trim ' + v);
        if (audio) { await fitClip(p, audio, tpf, want, 'trim A' + (x.aIdx + 1)); }
      }
      result.push(await clipInfo(it, tpf, v, null));
    }
    return { placed: result, audioTrack: 'A' + (prepared[0] ? prepared[0].aIdx + 1 : '?') };
  },

  async beat_cut(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const vCount = await seq.getVideoTrackCount();
    const trackName = a.track || ('V' + (vCount + 1));
    const cuts = a.cuts.map((t) => toTicks(t, tpf));
    const end = toTicks(a.end, tpf);
    for (let i = 1; i < cuts.length; i++) { if (cuts[i] <= cuts[i - 1]) { throw new Error('cuts must be strictly ascending (after frame snapping): ' + a.cuts[i - 1] + ' → ' + a.cuts[i]); } }
    if (end <= cuts[cuts.length - 1]) { throw new Error('"end" must be after the last cut.'); }
    const track = await getTrack(seq, trackName);
    if (track) {
      for (const it of await trackClips(track)) {
        if (ticksOf(await it.getEndTime()) > cuts[0]) {
          throw new Error(trackName + ' has clips after the first cut. Use an empty track (omit "track" to get a new one: V' + (vCount + 1) + ').');
        }
      }
    }
    const placements = cuts.map((c, i) => {
      const src = a.sources[i % a.sources.length];
      const next = i + 1 < cuts.length ? cuts[i + 1] : end;
      return { item: src.item, at: c / TPS, track: trackName, in: src.in, end: next / TPS, force: true };
    });
    const res = await HANDLERS.place({ sequence: a.sequence, placements });
    let audioRemoved = 0;
    if (a.videoOnly !== false) {
      /* place() put the linked audio on an empty track it chose, so everything on it is ours. */
      const aTrack = await getTrack(seq, res.audioTrack);
      if (aTrack) {
        const junk = await trackClips(aTrack);
        if (junk.length) {
          try { await removeItems(p, seq, junk, false, 'remove linked audio'); audioRemoved = junk.length; }
          catch (e) { res.audioNote = 'Linked audio is on ' + res.audioTrack + ' (could not remove it: ' + e.message + '). Mute or delete that track.'; }
        }
      }
    }
    const gaps = [];
    for (let i = 0; i < res.placed.length; i++) {
      const want = (i + 1 < cuts.length ? cuts[i + 1] : end) / TPS;
      if (Math.abs(res.placed[i].end - want) > tpf / TPS / 2) { gaps.push({ clip: i + 1, wantedEnd: +want.toFixed(4), gotEnd: res.placed[i].end }); }
    }
    return { track: trackName, clips: res.placed.length, audioRemoved, mismatches: gaps, placed: res.placed, audioNote: res.audioNote };
  },

  async edit_clips(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const jobs = [];
    for (const e of a.edits) { jobs.push({ e, it: await findClip(seq, e.clip, tpf) }); }
    /* Each change is its own undo step (see fitClip for why). Order per clip:
       in (slip: start and length stay), out (tail trim), start (head trim), end (tail trim), moveTo, name, disabled. */
    for (const { e, it } of jobs) {
      const lbl = 'edit ' + e.clip.track;
      if (e.in !== undefined) {
        const c = await clipTimes(it);
        await fitClip(p, it, tpf, { inT: toTicks(e.in, tpf), len: c.e - c.s, at: c.s }, lbl);
      }
      if (e.out !== undefined) { transact(p, lbl + ': source out', () => [it.createSetOutPointAction(tick(toTicks(e.out, tpf)))]); }
      if (e.start !== undefined) { transact(p, lbl + ': trim head', () => [it.createSetStartAction(tick(toTicks(e.start, tpf)))]); }
      if (e.end !== undefined) { transact(p, lbl + ': trim tail', () => [it.createSetEndAction(tick(toTicks(e.end, tpf)))]); }
      if (e.moveTo !== undefined) { await fitClip(p, it, tpf, { at: toTicks(e.moveTo, tpf) }, lbl); }
      if (e.name !== undefined || e.disabled !== undefined) {
        transact(p, lbl + ': name/disabled', () => [
          e.name !== undefined ? it.createSetNameAction(e.name) : null,
          e.disabled !== undefined ? it.createSetDisabledAction(!!e.disabled) : null]);
      }
    }
    const after = [];
    for (const { it, e } of jobs) { after.push(await clipInfo(it, tpf, e.clip.track, e.clip.index || null)); }
    return { edited: after };
  },

  async remove(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const items = [];
    for (const c of a.clips) { items.push(await findClip(seq, c, tpf)); }
    await removeItems(p, seq, items, a.ripple, 'remove ' + items.length + ' clip(s)' + (a.ripple ? ' (ripple)' : ''));
    return { removed: items.length, ripple: !!a.ripple };
  },

  async apply_effect(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const jobs = [];
    for (const c of a.clips) {
      const it = await findClip(seq, c, tpf);
      const chain = await it.getComponentChain();
      const comp = await ppro.VideoFilterFactory.createComponent(a.effect);
      jobs.push({ chain, comp });
    }
    transact(p, 'apply ' + a.effect, () => jobs.map((j) => j.chain.createAppendComponentAction(j.comp)));
    return { applied: a.effect, clips: jobs.length };
  },

  /* Effects and their parameters on one or more clips.
     action list: every component (Opacity, Motion, added effects) with its params and current values.
     action add: append effect a.effect (match name or display name) to each clip.
     action set: params [{component, param, value}] — static value (turns keyframes off).
     action keyframes: params [{component, param, keys:[{t, value}], interp}] — t is seconds from the clip's start.
     Keyframe positions in the API are SOURCE times (clip in point + offset); this converts. */
  async effect(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const clips = [];
    for (const c of a.clips) { clips.push({ ref: c, it: await findClip(seq, c, tpf) }); }
    const norm = (s) => String(s || '').trim().toLowerCase();
    const comps = async (it) => {
      const chain = await it.getComponentChain();
      const out = [];
      for (let i = 0; i < chain.getComponentCount(); i++) {
        const c = chain.getComponentAtIndex(i);
        out.push({ c, i, name: await c.getDisplayName(), match: await c.getMatchName() });
      }
      return { chain, list: out };
    };
    const findComp = (list, want) => {
      const w = norm(want);
      const hit = list.filter((x) => norm(x.name) === w || norm(x.match) === w || norm(x.match).endsWith(w));
      if (!hit.length) { throw new Error('No component "' + want + '" on this clip. Has: ' + list.map((x) => x.name).join(', ')); }
      return hit[hit.length - 1].c; // last match = most recently added instance
    };
    const findParam = (c, want) => {
      if (typeof want === 'number') { return c.getParam(want); }
      const w = norm(want);
      for (let j = 0; j < c.getParamCount(); j++) { const prm = c.getParam(j); if (norm(prm.displayName) === w) { return prm; } }
      const names = []; for (let j = 0; j < c.getParamCount(); j++) { names.push(c.getParam(j).displayName); }
      throw new Error('No param "' + want + '". Params: ' + names.join(' | '));
    };
    const readVal = async (prm, t) => {
      try { const v = await prm.getValueAtTime(t); const x = v && v.value !== undefined ? v.value : v;
        return (x && typeof x === 'object' && x.x !== undefined) ? [x.x, x.y] : x; } catch (e) { return null; }
    };
    const mkKey = (prm, value) => {
      if (Array.isArray(value)) {
        try { return prm.createKeyframe(value); } catch (e) { /* try point */ }
        return prm.createKeyframe({ x: value[0], y: value[1] });
      }
      return prm.createKeyframe(value);
    };
    const MODES = { linear: 'LINEAR', bezier: 'BEZIER', hold: 'HOLD', ease: 'BEZIER' };

    if (a.action === 'list') {
      const out = [];
      for (const { ref, it } of clips) {
        const inT = await it.getInPoint();
        const { list } = await comps(it);
        const rows = [];
        for (const x of list) {
          const params = [];
          for (let j = 0; j < x.c.getParamCount(); j++) {
            const prm = x.c.getParam(j);
            const tv = prm.isTimeVarying ? prm.isTimeVarying() : false;
            const row = { i: j, name: prm.displayName, value: await readVal(prm, inT), animated: tv };
            if (tv) { row.keys = (prm.getKeyframeListAsTickTimes() || []).map((t) => +(t.seconds - inT.seconds).toFixed(4)); }
            params.push(row);
          }
          rows.push({ index: x.i, name: x.name, matchName: x.match, params });
        }
        out.push({ clip: ref, components: rows });
      }
      return { clips: out };
    }

    assertWritable(p);
    if (a.action === 'add') {
      if (!a.effect) { throw new Error('add needs effect (match name or display name, see pr_effects_catalog).'); }
      if (a.clips.every((c) => /^A/i.test(String(c.track)))) {
        // Audio clips: audio effects are created by display name.
        const names = await ppro.AudioFilterFactory.getDisplayNames();
        const name = names.find((n) => norm(n) === norm(a.effect));
        if (!name) { throw new Error('Unknown audio effect "' + a.effect + '". Use pr_effects_catalog with audio: true.'); }
        const jobs = [];
        for (const { it } of clips) { jobs.push({ chain: await it.getComponentChain(), comp: await ppro.AudioFilterFactory.createComponentByDisplayName(name, it) }); }
        transact(p, 'add ' + name, () => jobs.map((j) => j.chain.createAppendComponentAction(j.comp)));
        if (!a.params || !a.params.length) { return { added: name, clips: clips.length }; }
        a = Object.assign({}, a, { action: (a.params.some((x) => x.keys) ? 'keyframes' : 'set') });
      }
    }
    if (a.action === 'add' && !a.clips.every((c) => /^A/i.test(String(c.track)))) {
      const [m, d] = await Promise.all([ppro.VideoFilterFactory.getMatchNames(), ppro.VideoFilterFactory.getDisplayNames()]);
      let match = a.effect;
      if (!m.includes(match)) {
        const i = d.findIndex((n) => norm(n) === norm(a.effect));
        if (i < 0) { throw new Error('Unknown video effect "' + a.effect + '". Use pr_effects_catalog.'); }
        match = m[i];
      }
      const jobs = [];
      for (const { it } of clips) { jobs.push({ chain: await it.getComponentChain(), comp: await ppro.VideoFilterFactory.createComponent(match) }); }
      transact(p, 'add ' + a.effect, () => jobs.map((j) => j.chain.createAppendComponentAction(j.comp)));
      if (!a.params || !a.params.length) { return { added: match, clips: clips.length }; }
      a = Object.assign({}, a, { action: (a.params.some((x) => x.keys) ? 'keyframes' : 'set') });
    }

    const changed = [];
    for (const { ref, it } of clips) {
      const inT = await it.getInPoint();
      const { list } = await comps(it);
      for (const spec of a.params || []) {
        const prm = findParam(findComp(list, spec.component), spec.param);
        const label = spec.component + '.' + prm.displayName;
        if (spec.keys && spec.keys.length) {
          if (!prm.areKeyframesSupported()) { throw new Error(label + ' cannot be keyframed.'); }
          const keys = spec.keys.map((k) => {
            const kf = mkKey(prm, k.value);
            kf.position = tick(ticksOf(inT) + toTicks(k.t, tpf));
            return kf;
          });
          const mode = MODES[norm(spec.interp || 'bezier')] || 'BEZIER';
          // Replace: drop old keys, switch on animation, add new keys — each its own step.
          if (prm.isTimeVarying()) {
            transact(p, label + ': clear keys', () => [prm.createSetTimeVaryingAction(false)]);
          }
          transact(p, label + ': animate', () => [prm.createSetTimeVaryingAction(true)]);
          transact(p, label + ': ' + keys.length + ' keys', () => keys.map((kf) => prm.createAddKeyframeAction(kf)));
          const im = ppro.Constants.InterpolationMode[mode];
          try { transact(p, label + ': ' + mode.toLowerCase(), () => keys.map((kf) => prm.createSetInterpolationAtKeyframeAction(kf.position, im, true))); }
          catch (e) { /* interpolation is cosmetic; keep keys */ }
          changed.push({ clip: ref, param: label, keys: keys.length, interp: mode.toLowerCase() });
        } else if (spec.value !== undefined) {
          if (prm.isTimeVarying()) { transact(p, label + ': static', () => [prm.createSetTimeVaryingAction(false)]); }
          transact(p, label + ' = ' + JSON.stringify(spec.value), () => [prm.createSetValueAction(mkKey(prm, spec.value), true)]);
          changed.push({ clip: ref, param: label, value: await readVal(prm, inT) });
        }
      }
    }
    return { changed };
  },

  /* Video transition at the start or end of clips. name: match name or a loose name ("cross dissolve", "dip to black", "whip"). */
  async transition(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const all = await ppro.TransitionFactory.getVideoTransitionMatchNames();
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let match = all.find((m) => m === a.name);
    if (!match) {
      const w = norm(a.name);
      const hits = all.filter((m) => norm(m).includes(w));
      // Prefer Adobe's own over plug-in packs when several match.
      match = hits.find((m) => /^AE\.ADBE|^ADBE/.test(m)) || hits[0];
    }
    if (!match) { throw new Error('No transition matches "' + a.name + '". Ask for list: true.'); }
    const jobs = [];
    for (const c of a.clips) {
      const it = await findClip(seq, c, tpf);
      const tr = await ppro.TransitionFactory.createVideoTransition(match);
      const opt = new ppro.AddTransitionOptions();
      if (a.duration !== undefined) { opt.setDuration(tick(toTicks(a.duration, tpf))); }
      opt.setApplyToStart(a.at === 'start');
      if (a.single) { opt.setForceSingleSided(true); }
      jobs.push({ it, tr, opt });
    }
    transact(p, 'transition ' + match, () => jobs.map((j) => j.it.createAddVideoTransitionAction(j.tr, j.opt)));
    return { transition: match, clips: jobs.length, at: a.at === 'start' ? 'start' : 'end' };
  },

  async transitions_catalog(a) {
    const all = await ppro.TransitionFactory.getVideoTransitionMatchNames();
    const q = a.query ? a.query.toLowerCase() : null;
    return { transitions: all.filter((m) => !q || m.toLowerCase().includes(q)) };
  },

  /* Create a bin (nested path "A/B" allowed) and optionally move project items into it. */
  async bin(a) {
    const p = await project();
    assertWritable(p);
    const parts = String(a.path || '').split('/').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) { throw new Error('bin needs path, e.g. "Raw" or "Footage/Day 1".'); }
    let folder = ppro.FolderItem.cast(await p.getRootItem());
    for (const name of parts) {
      let next = null;
      for (const it of await folder.getItems()) {
        if (it.name === name && it.type === ppro.ProjectItem.TYPE_BIN) { next = ppro.FolderItem.cast(it); break; }
      }
      if (!next) {
        const f = folder;
        transact(p, 'bin ' + name, () => [f.createBinAction(name, true)]);
        for (const it of await f.getItems()) { if (it.name === name) { next = ppro.FolderItem.cast(it); break; } }
        if (!next) { throw new Error('Could not create bin "' + name + '".'); }
      }
      folder = next;
    }
    let moved = 0;
    if (a.items && a.items.length) {
      const root = ppro.FolderItem.cast(await p.getRootItem());
      const targets = [];
      for (const name of a.items) { targets.push(await findItem(p, name)); }
      const dest = folder;
      transact(p, 'move ' + targets.length + ' items to ' + a.path, () => targets.map((t) => root.createMoveItemAction(t, dest)));
      moved = targets.length;
    }
    return { bin: parts.join('/'), moved };
  },

  /* Razor (C): split clips at times. The API has no razor, so for each cut:
     copy the clip to an empty spare track, trim the original's tail to t, trim the copy's head to t,
     clone the copy back down into the gap, then delete the spare copy. */
  async razor(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const times = (a.at || []).map((t) => toTicks(t, tpf)).sort((x, y) => x - y);
    const tracks = a.tracks && a.tracks.length ? a.tracks : ['V1'];
    const cuts = [];
    for (const name of tracks) {
      const { kind, index } = trackRef(name);
      const count = kind === 'V' ? await seq.getVideoTrackCount() : await seq.getAudioTrackCount();
      for (const t of times) {
        const row = (await trackRows(seq, name)).find((r) => t > r.s + tpf / 2 && t < r.e - tpf / 2);
        if (!row) { cuts.push({ track: name, at: +(t / TPS).toFixed(4), skipped: 'no clip spans this time' }); continue; }
        // Spare track: first track above with nothing between the clip's start and end.
        let spare = -1;
        for (let k = index + 1; k < count; k++) {
          const rows = await trackRows(seq, kind + (k + 1));
          if (!rows.some((r) => r.e > row.s && r.s < row.e)) { spare = k; break; }
        }
        if (spare < 0) { throw new Error('Razor on ' + name + ' needs an empty ' + (kind === 'V' ? 'video' : 'audio') + ' track above it for a moment. Add one (Sequence > Add Tracks).'); }
        const up = spare - index;
        transact(p, 'razor: copy up', () => [cloneAction(seq, row.it, 0, kind === 'V' ? up : 0, kind === 'A' ? up : 0)]);
        const copy = (await trackRows(seq, kind + (spare + 1))).find((r) => Math.abs(r.s - row.s) < tpf / 2);
        if (!copy) { throw new Error('Razor: the copy did not appear on ' + kind + (spare + 1) + '.'); }
        transact(p, 'razor: tail', () => [row.it.createSetEndAction(tick(t))]);
        transact(p, 'razor: head', () => [copy.it.createSetStartAction(tick(t))]);
        transact(p, 'razor: copy down', () => [cloneAction(seq, copy.it, 0, kind === 'V' ? -up : 0, kind === 'A' ? -up : 0)]);
        await removeItems(p, seq, [copy.it], false, 'razor: clean up');
        cuts.push({ track: name, at: +(t / TPS).toFixed(4) });
      }
    }
    return { cuts };
  },

  /* Ripple trim (B): trim a clip's head or tail to a time and shift every later clip on that track by the same amount. */
  async ripple_trim(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const it = await findClip(seq, a.clip, tpf);
    const c = await clipTimes(it);
    const to = toTicks(a.to, tpf);
    const later = (await trackRows(seq, a.clip.track)).filter((r) => r.s >= c.e - tpf / 2).map((r) => r.it);
    let delta;
    if (a.edge === 'head') {
      // Trim the head, then pull the clip back to where it started, so the gap closes to the right.
      delta = -(to - c.s);
      if (to < c.s) { moveMany(p, later, delta, 'ripple: make room'); }
      transact(p, 'ripple: trim head', () => [it.createSetStartAction(tick(to))]);
      transact(p, 'ripple: keep start', () => [it.createMoveAction(tick(c.s - to))]);
      if (to > c.s) { moveMany(p, later, delta, 'ripple: close gap'); }
    } else {
      delta = to - c.e;
      if (delta > 0) { moveMany(p, later, delta, 'ripple: make room'); }
      transact(p, 'ripple: trim tail', () => [it.createSetEndAction(tick(to))]);
      if (delta < 0) { moveMany(p, later, delta, 'ripple: close gap'); }
    }
    return { clip: await clipInfo(it, tpf, a.clip.track, null), shifted: later.length, by: +(delta / TPS).toFixed(4) };
  },

  /* Rolling edit (N): move the cut between two touching clips; total length stays. */
  async roll(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const cut = toTicks(a.cut, tpf), to = toTicks(a.to, tpf);
    const rows = await trackRows(seq, a.track);
    const A = rows.find((r) => Math.abs(r.e - cut) < tpf / 2), B = rows.find((r) => Math.abs(r.s - cut) < tpf / 2);
    if (!A || !B) { throw new Error('No cut between two touching clips at ' + a.cut + ' on ' + a.track + '.'); }
    if (to <= A.s || to >= B.e) { throw new Error('The new cut must stay inside both clips.'); }
    if (to > cut) {
      transact(p, 'roll: B head', () => [B.it.createSetStartAction(tick(to))]);
      transact(p, 'roll: A tail', () => [A.it.createSetEndAction(tick(to))]);
    } else {
      transact(p, 'roll: A tail', () => [A.it.createSetEndAction(tick(to))]);
      transact(p, 'roll: B head', () => [B.it.createSetStartAction(tick(to))]);
    }
    return { before: await clipInfo(A.it, tpf, a.track, null), after: await clipInfo(B.it, tpf, a.track, null) };
  },

  /* Slide (U): move a clip left/right between its neighbours; the neighbours absorb the change, total length stays. */
  async slide(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const it = await findClip(seq, a.clip, tpf);
    const c = await clipTimes(it);
    const d = toTicks(a.by, tpf);
    const rows = await trackRows(seq, a.clip.track);
    const L = rows.find((r) => Math.abs(r.e - c.s) < tpf / 2), R = rows.find((r) => Math.abs(r.s - c.e) < tpf / 2);
    if (d > 0) {
      if (R) { transact(p, 'slide: next head', () => [R.it.createSetStartAction(tick(R.s + d))]); }
      transact(p, 'slide: move', () => [it.createMoveAction(tick(d))]);
      if (L) { transact(p, 'slide: prev tail', () => [L.it.createSetEndAction(tick(L.e + d))]); }
    } else if (d < 0) {
      if (L) { transact(p, 'slide: prev tail', () => [L.it.createSetEndAction(tick(L.e + d))]); }
      transact(p, 'slide: move', () => [it.createMoveAction(tick(d))]);
      if (R) { transact(p, 'slide: next head', () => [R.it.createSetStartAction(tick(R.s + d))]); }
    }
    return { clip: await clipInfo(it, tpf, a.clip.track, null), prev: !!L, next: !!R };
  },

  /* Track Select Forward (A) + drag: shift every clip that starts at or after "from" by "by" seconds, on the given tracks (default all). */
  async shift(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const from = toTicks(a.from, tpf), by = toTicks(a.by, tpf);
    let names = a.tracks;
    if (!names || !names.length) {
      names = [];
      for (let i = 0; i < await seq.getVideoTrackCount(); i++) { names.push('V' + (i + 1)); }
      for (let i = 0; i < await seq.getAudioTrackCount(); i++) { names.push('A' + (i + 1)); }
    }
    let moved = 0;
    for (const n of names) {
      const items = (await trackRows(seq, n)).filter((r) => r.s >= from - tpf / 2);
      if (by < 0) {
        const before = (await trackRows(seq, n)).filter((r) => r.s < from - tpf / 2);
        const lastEnd = before.length ? Math.max(...before.map((r) => r.e)) : 0;
        if (items.length && items[0].s + by < lastEnd - tpf / 2) { throw new Error(n + ': shifting left by ' + a.by + ' would overlap the clip before ' + a.from + '.'); }
      }
      moveMany(p, items.map((r) => r.it), by, 'shift ' + n);
      moved += items.length;
    }
    return { moved, by: +(by / TPS).toFixed(4) };
  },

  /* ---- Audio: clip gain in dB, fades, mute. Volume.Level is linear: dB = 20*log10(v) + 15 (0 dB = 0.1778). ---- */
  async audio(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const toLin = (db) => Math.pow(10, (db - 15) / 20);
    const toDb = (v) => v <= 0 ? -Infinity : +(20 * Math.log10(v) + 15).toFixed(2);
    const out = [];
    for (const c of a.clips) {
      const it = await findClip(seq, c, tpf);
      const chain = await it.getComponentChain();
      let vol = null;
      for (let i = 0; i < chain.getComponentCount(); i++) { const k = chain.getComponentAtIndex(i); if (/Internal Volume/.test(await k.getMatchName())) { vol = k; break; } }
      if (!vol) { throw new Error('No Volume component on ' + JSON.stringify(c) + ' (is it an audio clip?).'); }
      const level = vol.getParam(1), mute = vol.getParam(0);
      const t = await clipTimes(it), inT = await it.getInPoint();
      const src = (sec) => tick(ticksOf(inT) + toTicks(sec, tpf));
      const len = (t.e - t.s) / TPS;
      const base = a.gain !== undefined ? a.gain : toDb((await level.getValueAtTime(inT)).value);
      if (a.mute !== undefined) { transact(p, 'mute ' + a.mute, () => [mute.createSetValueAction(mute.createKeyframe(!!a.mute), true)]); }
      const keys = [];
      if (a.fadeIn) { keys.push([0, -96], [a.fadeIn, base]); }
      if (a.fadeOut) { keys.push([len - a.fadeOut, base], [len, -96]); }
      if (a.keys) { for (const k of a.keys) { keys.push([k.t, k.db]); } }
      if (keys.length) {
        if (level.isTimeVarying()) { transact(p, 'volume: clear keys', () => [level.createSetTimeVaryingAction(false)]); }
        transact(p, 'volume: animate', () => [level.createSetTimeVaryingAction(true)]);
        const kfs = keys.sort((x, y) => x[0] - y[0]).map(([s, db]) => { const k = level.createKeyframe(toLin(db)); k.position = src(Math.max(0, Math.min(len, s))); return k; });
        transact(p, 'volume: ' + kfs.length + ' keys', () => kfs.map((k) => level.createAddKeyframeAction(k)));
      } else if (a.gain !== undefined) {
        if (level.isTimeVarying()) { transact(p, 'volume: static', () => [level.createSetTimeVaryingAction(false)]); }
        transact(p, 'volume ' + a.gain + ' dB', () => [level.createSetValueAction(level.createKeyframe(toLin(a.gain)), true)]);
      }
      out.push({ clip: c, db: toDb((await level.getValueAtTime(inT)).value), animated: level.isTimeVarying(), keys: keys.length });
    }
    return { clips: out };
  },

  /* ---- Sequences ---- */
  async sequence_op(a) {
    const p = await project();
    const op = a.op;
    if (op === 'list') {
      const act = await p.getActiveSequence();
      const rows = [];
      for (const s of await p.getSequences()) { rows.push(Object.assign({ active: act && s.guid && act.guid && String(s.guid) === String(act.guid) }, await seqSummary(s))); }
      return { sequences: rows };
    }
    if (op === 'activate' || op === 'open') {
      const s = await sequence(p, a.sequence);
      await p.openSequence(s); await p.setActiveSequence(s);
      return { active: await s.name };
    }
    if (op === 'settings') {
      const s = await sequence(p, a.sequence);
      const st = await s.getSettings();
      const get = async (f) => { try { const v = await st[f](); return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; } catch (e) { return null; } };
      const r = {};
      for (const f of ['getVideoFrameRect', 'getVideoFrameRate', 'getVideoPixelAspectRatio', 'getAudioSampleRate', 'getAudioChannelCount', 'getEditingMode', 'getMaxRenderQuality', 'getMaximumBitDepth', 'getCompositeInLinearColor']) { r[f.replace(/^get/, '')] = await get(f); }
      try { const fr = await st.getVideoFrameRate(); r.fps = fr && fr.ticksPerFrame ? TPS / Number(fr.ticksPerFrame) : null; } catch (e) { /* skip */ }
      if (!a.width && !a.height && a.maxRenderQuality === undefined && a.maxBitDepth === undefined) { return { sequence: await s.name, settings: r }; }
      assertWritable(p);
      if (a.width || a.height) {
        const rect = await st.getVideoFrameRect();
        const w = a.width || rect.width, h = a.height || rect.height;
        await st.setVideoFrameRect(ppro.RectF ? Object.assign(new ppro.RectF(), { left: 0, top: 0, right: w, bottom: h, width: w, height: h }) : { left: 0, top: 0, width: w, height: h });
      }
      if (a.maxRenderQuality !== undefined) { await st.setMaxRenderQuality(!!a.maxRenderQuality); }
      if (a.maxBitDepth !== undefined) { await st.setMaximumBitDepth(!!a.maxBitDepth); }
      transact(p, 'sequence settings', () => [s.createSetSettingsAction(st)]);
      const st2 = await s.getSettings();
      return { sequence: await s.name, updated: true, maxRenderQuality: await st2.getMaxRenderQuality(), maxBitDepth: await st2.getMaximumBitDepth() };
    }
    assertWritable(p);
    if (op === 'create') {
      if (!a.name) { throw new Error('create needs name.'); }
      let s;
      if (a.fromMedia && a.fromMedia.length) {
        const items = []; for (const n of a.fromMedia) { items.push(await findItem(p, n)); }
        s = await p.createSequenceFromMedia(a.name, items);
      } else if (a.preset) { s = await p.createSequenceWithPresetPath(a.name, a.preset); }
      else { s = await p.createSequence(a.name); }
      return { created: s ? await s.name : a.name };
    }
    if (op === 'duplicate') {
      const s = await sequence(p, a.sequence);
      transact(p, 'duplicate sequence', () => [s.createCloneAction()]);
      return { duplicated: await s.name };
    }
    if (op === 'workarea') {
      const s = await sequence(p, a.sequence);
      const tpf = await tpfOf(s);
      if (a.in !== undefined && a.out !== undefined) { await ppro.WorkAreaUtils.setWorkAreaInOutPoints(s, tick(toTicks(a.in, tpf)), tick(toTicks(a.out, tpf))); }
      const i = await ppro.WorkAreaUtils.getWorkAreaInPoint(s), o = await ppro.WorkAreaUtils.getWorkAreaOutPoint(s);
      return { in: i && i.seconds, out: o && o.seconds };
    }
    if (op === 'delete') {
      if (a.confirm !== true) { throw new Error('delete removes the sequence from the project. Pass confirm: true only after the user agreed.'); }
      const s = await sequence(p, a.sequence);
      const n = await s.name;
      await p.deleteSequence(s);
      return { deleted: n };
    }
    throw new Error('Unknown op ' + op);
  },

  /* ---- Scene Edit Detection on clips (selects them, then runs Premiere's detector). ---- */
  async scene_detect(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    await seq.clearSelection();
    const sel = await seq.getSelection();
    for (const c of a.clips) { await sel.addItem(await findClip(seq, c, tpf)); }
    const op = { cut: ppro.SequenceUtils.SEQUENCE_OPERATION_APPLYCUT, markers: ppro.SequenceUtils.SEQUENCE_OPERATION_CREATEMARKER, subclips: ppro.SequenceUtils.SEQUENCE_OPERATION_CREATESUBCLIP }[a.mode || 'markers'];
    const ok = await ppro.SequenceUtils.performSceneEditDetectionOnSelection(op, sel); // probed: (operation, TrackItemSelection); other orders throw
    return { mode: a.mode || 'markers', ok };
  },

  /* ---- Speech to text on a project item (clip in the Project panel). ---- */
  async transcribe(a) {
    const p = await project();
    const item = ppro.ClipProjectItem.cast(await findItem(p, a.item));
    const lang = a.language || 'en-us';
    if (a.action === 'read') {
      if (!(await ppro.Transcript.hasTranscript(item))) { return { item: a.item, transcript: null }; }
      const json = await ppro.Transcript.exportToJSON(item);
      const t = typeof json === 'string' ? JSON.parse(json) : json;
      // Compact: words with times, grouped by segment.
      const segs = (t.segments || []).map((s) => ({ start: s.start, end: s.start + (s.duration || 0), speaker: s.speaker, text: (s.words || []).map((w) => w.text).join(' ') }));
      return { item: a.item, language: t.language, segments: segs.slice(0, a.limit || 500) };
    }
    assertWritable(p);
    if (!(await ppro.Transcript.isLanguagePackAvailable(lang))) { return { refused: 'Language pack ' + lang + ' is not installed. Install it in Premiere: Text panel > Transcript > Transcribe.' }; }
    // probed: needs the language OBJECT from querySupportedLanguages, not the code string.
    const langs = await ppro.Transcript.querySupportedLanguages();
    const langObj = langs.find((l) => String(l.languageCode).toLowerCase() === lang.toLowerCase() || String(l.locale).toLowerCase() === lang.toLowerCase());
    if (!langObj) { throw new Error('Unsupported language ' + lang + '. Use one of: ' + langs.map((l) => l.languageCode).join(', ')); }
    const ok = await ppro.Transcript.transcribeClipProjectItem(item, langObj);
    return { item: a.item, language: lang, started: ok, note: 'Runs in the background. Read with action "read".' };
  },

  /* ---- Text via Motion Graphics Templates ---- */
  async mogrts(a) {
    const q = a.query ? a.query.toLowerCase() : null;
    return { templates: listMogrts().filter((f) => !q || f.toLowerCase().includes(q)).map((f) => f.replace(/^.*[\\/]/, '').replace(/\.mogrt$/i, '')) };
  },

  async text(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const items = [];
    for (const row of a.items || [{ text: a.text, at: a.at, duration: a.duration }]) {
      items.push(await placeText(p, seq, tpf, Object.assign({ template: a.template, track: a.track, font: a.font, size: a.size }, row)));
    }
    return { placed: items };
  },

  /* Captions from a transcript: group words into short lines, place one text clip per line. */
  async captions(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const item = ppro.ClipProjectItem.cast(await findItem(p, a.item));
    if (!(await ppro.Transcript.hasTranscript(item))) { throw new Error('No transcript on ' + a.item + '. Run pr_transcribe first.'); }
    const raw = await ppro.Transcript.exportToJSON(item);
    const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const words = [];
    for (const s of t.segments || []) { for (const w of s.words || []) { if (String(w.text).trim()) { words.push({ text: String(w.text).trim(), s: w.start, e: w.start + (w.duration || 0) }); } } }
    // Source time -> sequence time: offset given by the user (where the clip's source 0 sits), default 0.
    const off = a.offset || 0;
    const maxW = a.wordsPerLine || 3, gapBreak = 0.6;
    const lines = [];
    let cur = [];
    for (const w of words) {
      if (cur.length && (cur.length >= maxW || w.s - cur[cur.length - 1].e > gapBreak || /[.?!,]$/.test(cur[cur.length - 1].text))) { lines.push(cur); cur = []; }
      cur.push(w);
    }
    if (cur.length) { lines.push(cur); }
    const rows = lines.map((l) => ({ text: (a.upper ? l.map((w) => w.text.toUpperCase()) : l.map((w) => w.text)).join(' '), at: l[0].s + off, duration: Math.max(0.3, l[l.length - 1].e - l[0].s) }))
      .filter((r) => (a.from === undefined || r.at >= a.from) && (a.to === undefined || r.at < a.to));
    if (a.dryRun) { return { lines: rows.length, preview: a.all ? rows : rows.slice(0, 30) }; }
    const placed = [];
    for (const r of rows) { placed.push(await placeText(p, seq, tpf, Object.assign({ template: a.template || 'Bold Web Caption', track: a.track, font: a.font, size: a.size }, r))); }
    return { lines: placed.length, first: placed.slice(0, 5) };
  },

  /* ---- Project item tools: colour label, subclip, proxy, offline check, metadata read. ---- */
  async item(a) {
    const p = await project();
    const raw = await findItem(p, a.item);
    const it = ppro.ClipProjectItem.cast(raw);
    const r = { item: a.item };
    if (a.op === 'info') {
      const safe = async (f) => { try { const v = await f(); return v && typeof v === 'object' ? (v.seconds !== undefined ? v.seconds : JSON.parse(JSON.stringify(v))) : v; } catch (e) { return null; } };
      Object.assign(r, { path: await safe(() => it.getMediaFilePath()), offline: await safe(() => it.isOffline()), hasProxy: await safe(() => it.hasProxy()),
        proxyPath: await safe(() => it.getProxyPath()), colorLabel: await safe(() => it.getColorLabelIndex()), inPoint: await safe(() => it.getInPoint()), outPoint: await safe(() => it.getOutPoint()) });
      try { const md = await ppro.Metadata.getProjectMetadata(raw); r.metadataBytes = String(md).length; } catch (e) { /* no metadata */ }
      return r;
    }
    assertWritable(p);
    if (a.op === 'label') { transact(p, 'label', () => [it.createSetColorLabelAction(a.label)]); r.label = a.label; }
    else if (a.op === 'subclip') {
      const tpf = TPS / 30;
      // probed: (name, in, out, hardBoundaries) — 3 args = "Not Enough Parameters".
      transact(p, 'subclip ' + a.name, () => [it.createSubClipAction(a.name, tick(toTicks(a.in, tpf)), tick(toTicks(a.out, tpf)), false)]);
      r.subclip = a.name;
    } else if (a.op === 'proxy') {
      if (!a.path) { throw new Error('proxy needs path to the proxy file.'); }
      r.attached = await it.attachProxy(a.path, false);
    } else { throw new Error('op must be info | label | subclip | proxy'); }
    return r;
  },

  /* ---- Timeline health: gaps, overlaps-by-track-end, disabled clips, offline media, very short clips. ---- */
  async health(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const issues = [];
    const nV = await seq.getVideoTrackCount(), nA = await seq.getAudioTrackCount();
    const names = []; for (let i = 0; i < nV; i++) { names.push('V' + (i + 1)); } for (let i = 0; i < nA; i++) { names.push('A' + (i + 1)); }
    let end = 0;
    const perTrack = {};
    for (const n of names) {
      const rows = await trackRows(seq, n);
      perTrack[n] = rows.length;
      if (!rows.length) { issues.push({ type: 'empty track', track: n }); continue; }
      end = Math.max(end, rows[rows.length - 1].e);
      if (n === 'V1' && rows[0].s > tpf / 2) { issues.push({ type: 'gap at start', track: n, seconds: +(rows[0].s / TPS).toFixed(3) }); }
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (i && r.s - rows[i - 1].e > tpf / 2) { issues.push({ type: 'gap', track: n, from: +(rows[i - 1].e / TPS).toFixed(3), to: +(r.s / TPS).toFixed(3) }); }
        if (r.e - r.s < tpf * 3) { issues.push({ type: 'flash frame', track: n, at: +(r.s / TPS).toFixed(3), frames: Math.round((r.e - r.s) / tpf) }); }
        try { if (await r.it.isDisabled()) { issues.push({ type: 'disabled', track: n, at: +(r.s / TPS).toFixed(3) }); } } catch (e) { /* n/a */ }
        try { const pi = ppro.ClipProjectItem.cast(await r.it.getProjectItem()); if (await pi.isOffline()) { issues.push({ type: 'offline', track: n, at: +(r.s / TPS).toFixed(3), name: pi.name }); } } catch (e) { /* n/a */ }
      }
    }
    return { sequenceEnd: +(end / TPS).toFixed(3), clips: perTrack, issues };
  },

  /* ---- Paste attributes: copy added effects (and optionally Motion/Opacity values) from one clip to others. ---- */
  async copy_effects(a) {
    const p = await project();
    assertWritable(p);
    const seq = await sequence(p, a.sequence);
    const tpf = await tpfOf(seq);
    const src = await findClip(seq, a.from, tpf);
    const sc = await src.getComponentChain();
    const srcInT = await src.getInPoint();
    const comps = [];
    for (let i = 0; i < sc.getComponentCount(); i++) {
      const c = sc.getComponentAtIndex(i);
      const match = await c.getMatchName();
      const builtin = /ADBE Opacity|ADBE Motion|Internal Volume|Internal Channel Volume/.test(match);
      if (builtin && !a.includeMotion) { continue; }
      const vals = [];
      for (let j = 0; j < c.getParamCount(); j++) { const q = c.getParam(j); try { vals.push((await q.getValueAtTime(srcInT)).value); } catch (e) { vals.push(undefined); } }
      comps.push({ match, builtin, vals });
    }
    const done = [];
    for (const ref of a.to) {
      const it = await findClip(seq, ref, tpf);
      const chain = await it.getComponentChain();
      for (const cp of comps) {
        let target = null;
        if (cp.builtin) {
          for (let i = 0; i < chain.getComponentCount(); i++) { const c = chain.getComponentAtIndex(i); if ((await c.getMatchName()) === cp.match) { target = c; break; } }
        } else {
          const comp = await ppro.VideoFilterFactory.createComponent(cp.match.replace(/^AE\./, '').startsWith('ADBE') ? cp.match : cp.match);
          transact(p, 'paste ' + cp.match, () => [chain.createAppendComponentAction(comp)]);
          target = chain.getComponentAtIndex(chain.getComponentCount() - 1);
        }
        if (!target) { continue; }
        // Actions must be built inside transact (lockedAccess); building them outside made the paste a silent no-op.
        // Skip object params (Lumetri Blob/LUT data) and values already equal; one step per param so one bad param can't void the rest.
        const inT = await it.getInPoint();
        for (let j = 0; j < cp.vals.length; j++) {
          const v = cp.vals[j];
          if (v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v))) { continue; }
          const q = target.getParam(j);
          let cur; try { cur = (await q.getValueAtTime(inT)).value; } catch (e) { continue; }
          if (JSON.stringify(cur) === JSON.stringify(v)) { continue; }
          try { transact(p, 'paste ' + q.displayName, () => [q.createSetValueAction(q.createKeyframe(v), true)]); } catch (e) { /* not settable */ }
        }
      }
      done.push(ref);
    }
    return { copied: comps.map((c) => c.match), to: done.length, note: 'Static values copied; keyframes are not.' };
  },

  /* ---- Export ---- */
  async export(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const preset = resolvePreset(a.preset || 'h264-high');
    const ext = await ppro.EncoderManager.getExportFileExtension(seq, preset).catch(() => null) || presetExt(preset);
    const seqName = String(await seq.name).replace(/[\\/:*?"<>|]/g, '_');
    const outDir = winDir(p.path) + 'Exports';
    const output = a.output || (outDir + SEP + seqName + '.' + String(ext).replace(/^\./, ''));
    const mode = { app: ppro.Constants.ExportType.QUEUE_TO_APP, ame: ppro.Constants.ExportType.QUEUE_TO_AME, immediate: ppro.Constants.ExportType.IMMEDIATELY }[a.mode || 'immediate'];
    const full = (a.range || 'full') !== 'workarea';
    const plan = { sequence: seqName, preset, output, mode: a.mode || 'immediate', range: full ? 'full' : 'workarea' };
    if (a.dryRun) { return Object.assign({ dryRun: true }, plan); }
    try { require('fs').mkdirSync(output.replace(/[\\/][^\\/]*$/, ''), { recursive: true }); } catch (e) { /* exists */ }
    watchRenders();
    const em = await ppro.EncoderManager.getManager();
    const ok = await em.exportSequence(seq, mode, output, preset, full);
    // Queued jobs sit idle until the queue is started (QUEUE_TO_APP returned false and rendered nothing without this).
    if (a.mode !== 'immediate') { try { await em.startBatchEncode(); } catch (e) { /* queue may already run */ } }
    exportLog.push({ at: new Date().toISOString(), event: 'started', output, ok });
    return Object.assign({ started: ok !== false }, plan);
  },

  async export_status() {
    watchRenders();
    return { events: exportLog.slice(-20) };
  },

  async export_presets(a) {
    const q = a.query ? a.query.toLowerCase() : null;
    // Folder names are hex FourCCs (4E49434B_48323634 = "NICK_H264"); decode them so "h264", "hevc", "mov" match.
    const label = (f) => { const m = f.match(/[\\/]([0-9A-Fa-f]{8})_([0-9A-Fa-f]{8})[\\/]/); if (!m) { return ''; }
      return [m[1], m[2]].map((h) => h.match(/../g).map((b) => String.fromCharCode(parseInt(b, 16))).join('').trim()).join(' '); };
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const rows = listPresets().map((f) => ({ format: label(f), name: f.replace(/^.*[\\/]/, '').replace(/\.epr$/i, ''), path: f }));
    return { presets: rows.filter((r) => !q || norm(r.format + r.name).includes(norm(q))).slice(0, 150) };
  },

  async interchange(a) {
    const p = await project();
    const seq = await sequence(p, a.sequence);
    const ext = { otio: 'otio', fcpxml: 'xml', aaf: 'aaf' }[a.format];
    const seqName = String(await seq.name).replace(/[\\/:*?"<>|]/g, '_');
    const output = a.output || (winDir(p.path) + 'Exports' + SEP + seqName + '.' + ext);
    try { require('fs').mkdirSync(output.replace(/[\\/][^\\/]*$/, ''), { recursive: true }); } catch (e) { /* exists */ }
    const PC = ppro.ProjectConverter;
    let ok;
    if (a.format === 'otio') { ok = await PC.exportAsOpenTimelineIO(seq, output); }
    else if (a.format === 'fcpxml') { ok = await PC.exportAsFinalCutProXML(seq, output); }
    else { ok = await PC.exportAAF(seq, output); }
    return { format: a.format, output, ok };
  },

  async save() {
    const p = await project();
    assertWritable(p);
    return { saved: await p.save(), path: p.path };
  },

  async eval(a) {
    if (store.get('raw', '0') !== '1') { throw new Error('Refused: raw scripts are off. Ask the user to tick "Allow raw scripts" in the panel.'); }
    const AsyncFn = Object.getPrototypeOf(async function () { /* probe */ }).constructor;
    const h = { project, sequence, tpfOf, toTicks, tick, ticksOf, getTrack, trackClips, clipInfo, findClip, findItem, transact, walk, TPS };
    const r = await new AsyncFn('ppro', 'h', a.code)(ppro, h);
    try { return JSON.parse(JSON.stringify(r === undefined ? null : r)); } catch (e) { return String(r); }
  }
};

const COLORS = { green: 0, red: 1, purple: 2, magenta: 2, orange: 3, yellow: 4, white: 5, blue: 6, cyan: 7 };
function colorIndex(c) { return typeof c === 'number' ? c : (COLORS[String(c).toLowerCase()] !== undefined ? COLORS[String(c).toLowerCase()] : 0); }

async function listMarkers(seq, tpf) {
  try {
    const M = await ppro.Markers.getMarkers(seq);
    return M.getMarkers().map((m) => {
      const s = ticksOf(m.getStart());
      return { time: +(s / TPS).toFixed(4), frame: Math.round(s / tpf), name: m.getName(), comment: m.getComments(),
               duration: +(ticksOf(m.getDuration()) / TPS).toFixed(4), type: m.getType(), color: m.getColorIndex() };
    }).sort((x, y) => x.time - y.time);
  } catch (e) { return { error: e.message }; }
}

connect();
