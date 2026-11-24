#!/usr/bin/env node
/*
 * pr-mcp.js — MCP server exposing a live Adobe Premiere Pro session.
 *
 * Zero dependencies. Speaks newline-delimited JSON-RPC on stdio (MCP), and
 * runs a small WebSocket server on 127.0.0.1 that the "Premiere MCP Bridge"
 * UXP panel connects to. UXP plugins cannot listen on a port, so the roles are
 * the reverse of the After Effects bridge: here the MCP server is the socket
 * server and the panel is the client.
 *
 * Structure modelled on aftereffects-mcp (MIT, Solomon Divyananth).
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.PR_BRIDGE_PORT || '7790', 10);
const HOST = '127.0.0.1';
const STATE_PATH = path.join(os.homedir(), '.pr-mcp-bridge.json');
const FRAME_DIR = path.join(os.tmpdir(), 'pr-mcp-frames');
const MAX_IMAGE_PX = parseInt(process.env.PR_BRIDGE_MAX_PX || '1024', 10);
const CALL_TIMEOUT_MS = 300000;
const SERVER_NAME = 'premiere-pro';
const SERVER_VERSION = '0.2.0';
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/* ------------------------------------------------------------------ */
/* Shared secret                                                       */
/* ------------------------------------------------------------------ */

/* The token lives in ~/.pr-mcp-bridge.json and survives restarts, so the
   panel only has to be paired once. Without it the socket refuses the panel —
   which is what stops a web page from driving Premiere through localhost. */
function loadToken() {
  if (process.env.PR_BRIDGE_TOKEN) { return process.env.PR_BRIDGE_TOKEN; }
  try {
    const t = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).token;
    if (t && t.length >= 32) { return t; }
  } catch (e) { /* create below */ }
  const token = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(STATE_PATH, JSON.stringify({ token, port: PORT }, null, 2), { mode: 0o600 });
  return token;
}
const TOKEN = loadToken();

/* ------------------------------------------------------------------ */
/* Minimal WebSocket server (RFC 6455, text frames only)               */
/* ------------------------------------------------------------------ */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let panel = null;          // { sock, info } once authenticated
let listenError = null;
let nextId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

function wsSend(sock, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  let head;
  if (data.length < 126) {
    head = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2);
  } else {
    head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2);
  }
  sock.write(Buffer.concat([head, data]));
}

function wsControl(sock, opcode, payload) {
  const p = payload || Buffer.alloc(0);
  sock.write(Buffer.concat([Buffer.from([0x80 | opcode, p.length]), p]));
}

function attachParser(sock, onText) {
  let buf = Buffer.alloc(0);
  let frag = [];
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) { return; }
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) { return; } len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) { return; } len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024 * 1024) { sock.destroy(); return; }
      const maskOff = off; if (masked) { off += 4; }
      if (buf.length < off + len) { return; }
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const m = buf.subarray(maskOff, maskOff + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) { payload[i] ^= m[i & 3]; }
      }
      buf = buf.subarray(off + len);
      if (opcode === 0x8) { try { wsControl(sock, 0x8); } catch (e) { /* closing */ } sock.end(); return; }
      if (opcode === 0x9) { wsControl(sock, 0xA, payload); continue; }
      if (opcode === 0xA) { continue; }
      if (opcode === 0x1 || opcode === 0x0) {
        frag.push(payload);
        if (fin) { const text = Buffer.concat(frag).toString('utf8'); frag = []; onText(text); }
      }
    }
  });
}

function dropPanel(reason) {
  if (!panel) { return; }
  panel = null;
  for (const [id, p] of pending) {
    clearTimeout(p.timer);
    p.reject(new Error('The Premiere panel disconnected (' + reason + '). If the call was an edit, read the sequence back before repeating it.'));
    pending.delete(id);
  }
}

function startSocketServer() {
  const server = http.createServer((req, res) => { res.writeHead(426); res.end('WebSocket only'); });
  server.on('upgrade', (req, sock) => {
    /* Browsers always send an http(s) Origin; the UXP panel does not. */
    const origin = req.headers.origin || '';
    if (/^https?:\/\//i.test(origin) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
               'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sock.setNoDelay(true);
    let authed = false;
    const authTimer = setTimeout(() => { if (!authed) { sock.destroy(); } }, 5000);
    attachParser(sock, (text) => {
      let msg; try { msg = JSON.parse(text); } catch (e) { return; }
      if (!authed) {
        if (msg.type === 'hello' && typeof msg.token === 'string' && msg.token.length === TOKEN.length &&
            crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(TOKEN))) {
          authed = true; clearTimeout(authTimer);
          if (panel && panel.sock !== sock) { try { panel.sock.destroy(); } catch (e) { /* gone */ } dropPanel('replaced by a new panel connection'); }
          panel = { sock, info: msg.info || {} };
          wsSend(sock, { type: 'welcome', server: SERVER_VERSION });
        } else {
          wsSend(sock, { type: 'denied', error: 'Wrong token. The panel reads it from ' + STATE_PATH });
          sock.end();
        }
        return;
      }
      if (msg.type === 'info') { panel.info = msg.info || {}; return; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.ok) { p.resolve(msg.result); } else { p.reject(new Error(msg.error || 'Unknown panel error')); }
      }
    });
    sock.on('close', () => { if (panel && panel.sock === sock) { dropPanel('socket closed'); } });
    sock.on('error', () => { if (panel && panel.sock === sock) { dropPanel('socket error'); } });
  });
  server.on('error', (e) => {
    listenError = e.code === 'EADDRINUSE'
      ? 'Port ' + PORT + ' is taken — probably another Claude session already runs the Premiere bridge. Close it, or set PR_BRIDGE_PORT for both.'
      : e.message;
  });
  server.listen(PORT, HOST);
  server.unref();
}

function bridge(fn, args) {
  return new Promise((resolve, reject) => {
    if (listenError) { return reject(new Error(listenError)); }
    if (!panel) {
      return reject(new Error('The Premiere MCP Bridge panel is not connected. Open Premiere Pro, then Window ▸ UXP Plugins ▸ ' +
        'Premiere MCP Bridge (load it once with the UXP Developer Tool). It reads ' + STATE_PATH + ' and connects on its own.'));
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Premiere did not answer within 5 minutes. A dialog may be open, or it is busy. ' +
        'If this was an edit, it may have run — read the state back before repeating it.'));
    }, CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try { wsSend(panel.sock, { id, fn, args: args || {} }); }
    catch (e) { pending.delete(id); clearTimeout(timer); reject(e); }
  });
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

function obj(props, required) {
  return { type: 'object', properties: props, required: required || [], additionalProperties: false };
}
const S = {
  sequence: { type: 'string', description: 'Sequence name or guid. Omit for the active sequence.' },
  time: { type: ['number', 'string'], description: 'Seconds (2.5), frames ("75f") or timecode ("00:00:02:15"). Snapped to the sequence frame grid.' },
  track: { type: 'string', description: 'Track, e.g. "V1", "V2", "A1".' },
  clip: {
    type: 'object',
    description: 'A clip on the timeline: {track:"V1", index:3} (1-based, left to right) or {track:"V1", at:12.5} (the clip under that time).',
    properties: { track: { type: 'string' }, index: { type: 'number' }, at: { type: ['number', 'string'] } },
    required: ['track']
  },
  item: { type: 'string', description: 'Project item: its name, its bin path ("Footage/clip.mp4") or its media file path.' }
};

const TOOLS = [
  /* ---------------- Status & read ---------------- */
  { name: 'pr_status', description: 'Is the Premiere panel connected? Shows the bridge port, the token file, and what the panel reported (Premiere version, project, sandbox and guard state). Works without Premiere.',
    inputSchema: obj({}), local: 'status' },
  { name: 'pr_project_info', description: 'Overview of the open project: name, path, every sequence (frame size, fps, duration, track counts), the active sequence and the playhead. Cheap — call this first.',
    inputSchema: obj({}), fn: 'project_info' },
  { name: 'pr_sequence_tree', description: 'Every clip on the tracks of one sequence: track, 1-based index, name, source item, start/end on the timeline, source in/out, duration, disabled, and frames. Plus sequence markers.',
    inputSchema: obj({ sequence: S.sequence,
      tracks: { type: 'array', items: { type: 'string' }, description: 'Only these tracks, e.g. ["V1","A1"]. Default all.' },
      from: S.time, to: S.time }), fn: 'sequence_tree' },
  { name: 'pr_list_items', description: 'Project panel items (bins, clips, sequences) with type, bin path and media path. Filter with query (case-insensitive substring of the name).',
    inputSchema: obj({ query: { type: 'string' }, bin: { type: 'string', description: 'Only inside this bin path.' }, limit: { type: 'number', description: 'Default 300.' } }), fn: 'list_items' },
  { name: 'pr_effects_catalog', description: 'Installed video effects (match + display names) or, with audio: true, audio effects (display names). Filter with query.',
    inputSchema: obj({ query: { type: 'string' }, audio: { type: 'boolean' } }), fn: 'effects_catalog' },
  { name: 'pr_export_frame', description: 'Render sequence frames as images to look at (Exporter.exportSequenceFrame). Pass times; each comes back as an image, longest side ' + MAX_IMAGE_PX + ' px unless width is given.',
    inputSchema: obj({ sequence: S.sequence, times: { type: 'array', items: S.time, description: 'Up to 8 times.' },
      width: { type: 'number', description: 'Output width in px. Height follows the sequence aspect.' } }, ['times']), local: 'export_frame' },
  { name: 'pr_goto', description: 'Move the playhead of a sequence (and make it active) so the user sees the moment you mean.',
    inputSchema: obj({ sequence: S.sequence, time: S.time }, ['time']), fn: 'goto' },

  /* ---------------- Edit ---------------- */
  { name: 'pr_markers', description: 'Sequence markers. action list | add | remove | clear. add takes markers [{time, name, comment, duration, color (green|red|magenta|orange|yellow|blue|cyan|purple index 0-7), type (Comment|Chapter|Segmentation|WebLink)}] in one undo step. remove takes times or names; clear removes all (or those whose name matches "match").',
    inputSchema: obj({ sequence: S.sequence, action: { type: 'string', enum: ['list', 'add', 'remove', 'clear'] },
      markers: { type: 'array', items: { type: 'object' } },
      times: { type: 'array', items: S.time }, names: { type: 'array', items: { type: 'string' } },
      match: { type: 'string', description: 'Regex on marker name for clear.' } }, ['action']), fn: 'markers' },
  { name: 'pr_import', description: 'Import media files into the project (optionally into a bin path, created if missing).',
    inputSchema: obj({ files: { type: 'array', items: { type: 'string' } }, bin: { type: 'string' } }, ['files']), fn: 'import' },
  { name: 'pr_place', description: 'Put project items on the timeline. Each placement: {item, at, track ("V1"; linked audio goes to a NEW audio track unless audioTrack is given), mode overwrite|insert (default overwrite), in (source in, seconds/frames), duration or end (trims the new clip; linked audio gets the same trim)}. Clips are placed and fitted one at a time, a few undo steps each. Returns the placed clips read back.',
    inputSchema: obj({ sequence: S.sequence, placements: { type: 'array', items: { type: 'object',
      properties: { item: S.item, at: S.time, track: S.track, audioTrack: S.track, mode: { type: 'string', enum: ['overwrite', 'insert'] },
        in: S.time, duration: S.time, end: S.time }, required: ['item', 'at'] } } }, ['placements']), fn: 'place' },
  { name: 'pr_beat_cut', description: 'Lay a run of clips on one track so each change lands on a cut time: clip i fills cuts[i] → cuts[i+1] (the last one fills to "end"). Sources: [{item, in}] cycled if shorter than the cut list. Use with beat times from earshot or a beat finder. Overwrite mode: nothing is inserted or rippled.',
    inputSchema: obj({ sequence: S.sequence, track: S.track, cuts: { type: 'array', items: S.time, description: 'Ascending cut times; the first is where the run starts.' },
      end: S.time, sources: { type: 'array', items: { type: 'object', properties: { item: S.item, in: S.time }, required: ['item'] } },
      videoOnly: { type: 'boolean', description: 'Default true: remove the linked audio the placement brings in.' } }, ['cuts', 'sources', 'end']), fn: 'beat_cut' },
  { name: 'pr_edit_clips', description: 'Change clips already on the timeline. Each edit: {clip, in, out, start, end, moveTo, name, disabled}, applied in that order, each as its own undo step. ' +
      'in = slip: new source in, clip keeps its timeline start and length. out = source out (moves the tail). start = trim the head on the timeline (source in moves with it). ' +
      'end = trim the tail on the timeline. moveTo = move the clip so it starts here, length and source unchanged. Times use the sequence frame grid. Linked audio is not changed.',
    inputSchema: obj({ sequence: S.sequence, edits: { type: 'array', items: { type: 'object',
      properties: { clip: S.clip, start: S.time, end: S.time, in: S.time, out: S.time, moveTo: S.time, name: { type: 'string' }, disabled: { type: 'boolean' } }, required: ['clip'] } } }, ['edits']), fn: 'edit_clips' },
  { name: 'pr_remove', description: 'Remove clips from the timeline. ripple:true closes the gap.',
    inputSchema: obj({ sequence: S.sequence, clips: { type: 'array', items: S.clip }, ripple: { type: 'boolean' } }, ['clips']), fn: 'remove' },
  { name: 'pr_apply_effect', description: 'Append a video effect (by match name from pr_effects_catalog, e.g. "AE.ADBE Gaussian Blur 2") to clips. One undo step.',
    inputSchema: obj({ sequence: S.sequence, clips: { type: 'array', items: S.clip }, effect: { type: 'string' } }, ['clips', 'effect']), fn: 'apply_effect' },
  { name: 'pr_effect', description: 'Effects and their settings on clips. action list: every component (Opacity, Motion, added effects) with params, current values and keyframe times. ' +
      'action add: append effect (match or display name) to each clip, optionally with params. action set: params [{component, param, value}] sets a static value. ' +
      'action keyframes: params [{component, param, keys:[{t, value}], interp: bezier|linear|hold}] replaces that param\'s animation; t = seconds from the clip\'s start. ' +
      'Motion params: Position [x,y] normalised 0..1 (0.5,0.5 = centre), Scale %, Rotation degrees, Anchor Point, Crop Left/Top/Right/Bottom %. Opacity: Opacity %. Each step is its own undo step.',
    inputSchema: obj({ sequence: S.sequence, clips: { type: 'array', items: S.clip },
      action: { type: 'string', enum: ['list', 'add', 'set', 'keyframes'] },
      effect: { type: 'string', description: 'For add: e.g. "Gaussian Blur", "Lumetri Color", "AE.ADBE Gaussian Blur 2".' },
      params: { type: 'array', items: { type: 'object', properties: {
        component: { type: 'string', description: 'Component display or match name, e.g. "Motion", "Opacity", "Gaussian Blur".' },
        param: { type: ['string', 'number'], description: 'Param display name (e.g. "Scale") or index.' },
        value: { description: 'Number, boolean or [x,y].' },
        keys: { type: 'array', items: { type: 'object', properties: { t: S.time, value: {} }, required: ['t', 'value'] } },
        interp: { type: 'string', enum: ['bezier', 'linear', 'hold'] } }, required: ['component', 'param'] } } }, ['clips', 'action']), fn: 'effect' },
  { name: 'pr_transition', description: 'Add a video transition at the start or end of clips (at the cut it sits on). name: match name or loose name ("cross dissolve", "dip to black", "whip", "film dissolve"); Adobe built-ins win over plug-in packs. One undo step.',
    inputSchema: obj({ sequence: S.sequence, clips: { type: 'array', items: S.clip }, name: { type: 'string' },
      at: { type: 'string', enum: ['start', 'end'], description: 'Default end.' }, duration: S.time,
      single: { type: 'boolean', description: 'Force single-sided.' } }, ['clips', 'name']), fn: 'transition' },
  { name: 'pr_transitions_catalog', description: 'Installed video transitions (match names). Filter with query.',
    inputSchema: obj({ query: { type: 'string' } }), fn: 'transitions_catalog' },
  { name: 'pr_bin', description: 'Create a bin (nested "A/B" allowed; existing bins are reused) and optionally move project items into it.',
    inputSchema: obj({ path: { type: 'string' }, items: { type: 'array', items: { type: 'string' }, description: 'Project item names to move into the bin.' } }, ['path']), fn: 'bin' },
  { name: 'pr_razor', description: 'Razor tool (C): split clips at times on the given tracks (default ["V1"]; add the A track to cut linked audio too). Needs an empty track above for a moment. Several undo steps per cut.',
    inputSchema: obj({ sequence: S.sequence, at: { type: 'array', items: S.time }, tracks: { type: 'array', items: { type: 'string' } } }, ['at']), fn: 'razor' },
  { name: 'pr_ripple_trim', description: 'Ripple edit tool (B): trim a clip\'s head or tail to a time and shift every later clip on that track by the same amount (closes or opens the gap).',
    inputSchema: obj({ sequence: S.sequence, clip: S.clip, edge: { type: 'string', enum: ['head', 'tail'] }, to: S.time }, ['clip', 'edge', 'to']), fn: 'ripple_trim' },
  { name: 'pr_roll', description: 'Rolling edit tool (N): move the cut between two touching clips on a track from "cut" to "to"; total length stays.',
    inputSchema: obj({ sequence: S.sequence, track: { type: 'string' }, cut: S.time, to: S.time }, ['track', 'cut', 'to']), fn: 'roll' },
  { name: 'pr_slide', description: 'Slide tool (U): move a clip by "by" seconds between its neighbours; the previous clip\'s tail and the next clip\'s head absorb it.',
    inputSchema: obj({ sequence: S.sequence, clip: S.clip, by: S.time }, ['clip', 'by']), fn: 'slide' },
  { name: 'pr_shift', description: 'Track Select Forward (A) + drag: move every clip starting at or after "from" by "by" seconds (negative = left) on the given tracks (default all). Refuses moves that would overlap.',
    inputSchema: obj({ sequence: S.sequence, from: S.time, by: S.time, tracks: { type: 'array', items: { type: 'string' } } }, ['from', 'by']), fn: 'shift' },
  { name: 'pr_export', heavy: true, description: 'Export a sequence to a video/audio file. preset: alias (h264-high default, h264-medium, h264-low, hevc, prores-hq, prores, wav, mp3, aac, png-seq, gif) or a full .epr path. ' +
      'mode: immediate (default; Premiere renders now and is busy until done) or ame (Media Encoder renders in the background). QUEUE_TO_APP returns false in Premiere 27, so app mode is not offered.Always renders the whole sequence (the API ignores the work area; range is kept for later). ' +
      'Output defaults to <project folder>\\Exports\\<sequence>.<ext>. Refused when RAM is low. Check progress with pr_export_status. dryRun: show what would run.',
    inputSchema: obj({ sequence: S.sequence, preset: { type: 'string' }, output: { type: 'string', description: 'Full output file path (optional).' },
      mode: { type: 'string', enum: ['immediate', 'ame'] }, range: { type: 'string', enum: ['full', 'workarea'] }, dryRun: { type: 'boolean' } }), fn: 'export' },
  { name: 'pr_export_status', description: 'Progress and result of exports started with pr_export (render events since the panel loaded).', inputSchema: obj({}), fn: 'export_status' },
  { name: 'pr_export_presets', description: 'Search installed .epr export presets (Premiere system presets + user presets). query filters by name or format folder.',
    inputSchema: obj({ query: { type: 'string' } }), fn: 'export_presets' },
  { name: 'pr_interchange', description: 'Export the sequence for other apps: otio (OpenTimelineIO), fcpxml (Final Cut Pro XML, also Resolve), aaf (Avid / Pro Tools). Output defaults to <project folder>\\Exports.',
    inputSchema: obj({ sequence: S.sequence, format: { type: 'string', enum: ['otio', 'fcpxml', 'aaf'] }, output: { type: 'string' } }, ['format']), fn: 'interchange' },
  { name: 'pr_audio', description: 'Audio clip levels: gain in dB (0 = unity), fadeIn/fadeOut seconds (to -96 dB), keys [{t, db}] for ducking (t = seconds from clip start), mute. For EQ/DeNoise/reverb use pr_effect add on audio clips.',
    inputSchema: obj({ sequence: S.sequence, clips: { type: 'array', items: S.clip }, gain: { type: 'number' }, fadeIn: S.time, fadeOut: S.time,
      keys: { type: 'array', items: { type: 'object', properties: { t: S.time, db: { type: 'number' } }, required: ['t', 'db'] } }, mute: { type: 'boolean' } }, ['clips']), fn: 'audio' },
  { name: 'pr_sequence', description: 'Sequences. op list | activate | settings (read; or set width/height/maxRenderQuality/maxBitDepth) | create (name, optional preset .sqpreset path or fromMedia item names) | duplicate | workarea (read; or set in/out) | delete (needs confirm: true, only after the user agreed).',
    inputSchema: obj({ op: { type: 'string', enum: ['list', 'activate', 'settings', 'create', 'duplicate', 'workarea', 'delete'] }, sequence: S.sequence, name: { type: 'string' },
      preset: { type: 'string' }, fromMedia: { type: 'array', items: { type: 'string' } }, width: { type: 'number' }, height: { type: 'number' },
      maxRenderQuality: { type: 'boolean' }, maxBitDepth: { type: 'boolean' }, in: S.time, out: S.time, confirm: { type: 'boolean' } }, ['op']), fn: 'sequence_op' },
  { name: 'pr_scene_detect', description: 'Scene Edit Detection on clips: mode markers (default, safe), cut (razor at every shot change), subclips.',
    inputSchema: obj({ sequence: S.sequence, clips: { type: 'array', items: S.clip }, mode: { type: 'string', enum: ['markers', 'cut', 'subclips'] },
      cutLinkedAudio: { type: 'boolean' }, sensitivity: { type: 'string', enum: ['Low', 'Medium', 'High'] } }, ['clips']), fn: 'scene_detect' },
  { name: 'pr_transcribe', description: 'Speech to text on a Project-panel clip. action start (default; runs in background, language e.g. en-us, hi-in) or read (segments with times, for captions, filler-word and silence cuts).',
    inputSchema: obj({ item: { type: 'string' }, action: { type: 'string', enum: ['start', 'read'] }, language: { type: 'string' }, limit: { type: 'number' } }, ['item']), fn: 'transcribe' },
  { name: 'pr_mogrts', description: 'Installed Motion Graphics Templates (titles, lower thirds, caption styles). Filter with query.',
    inputSchema: obj({ query: { type: 'string' } }), fn: 'mogrts' },
  { name: 'pr_text', local: 'text', description: 'Type tool: render text to a transparent full-frame PNG (saved in <project>\\MCP Text, bin "MCP Text") and place it on a video track (default V2). ' +
      'Style: font (Windows font family), size px, color/stroke hex, bold (default true), shadow (default true), y (vertical centre 0..1, default 0.5). items: several {text, at, duration}. Animate with pr_effect afterwards.',
    inputSchema: obj({ sequence: S.sequence, track: { type: 'string' }, text: { type: 'string' }, at: S.time, duration: S.time,
      font: { type: 'string' }, size: { type: 'number' }, color: { type: 'string' }, stroke: { type: 'string' }, bold: { type: 'boolean' }, shadow: { type: 'boolean' }, y: { type: 'number' },
      items: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, at: S.time, duration: S.time }, required: ['text', 'at'] } } }), fn: 'text' },
  { name: 'pr_captions', local: 'captions', description: 'Captions from a clip\'s transcript (run pr_transcribe first): groups words into short lines (wordsPerLine, default 3) and places one PNG text clip per line (style as pr_text; default size 88, y 0.72, black stroke). offset = sequence time where the clip\'s source 0 sits. dryRun previews lines.',
    inputSchema: obj({ sequence: S.sequence, item: { type: 'string' }, template: { type: 'string' }, track: { type: 'string' }, wordsPerLine: { type: 'number' },
      offset: S.time, from: S.time, to: S.time, upper: { type: 'boolean' }, font: { type: 'string' }, size: { type: 'number' }, dryRun: { type: 'boolean' } }, ['item']), fn: 'captions' },
  { name: 'pr_item', description: 'Project-panel clip tools. op info (path, offline, proxy, label, in/out) | label (colour label index 0-15) | subclip (name, in, out seconds) | proxy (attach proxy file path).',
    inputSchema: obj({ item: { type: 'string' }, op: { type: 'string', enum: ['info', 'label', 'subclip', 'proxy'] }, label: { type: 'number' }, name: { type: 'string' }, in: S.time, out: S.time, path: { type: 'string' } }, ['item', 'op']), fn: 'item' },
  { name: 'pr_health', description: 'Timeline check: gaps, gap at start, flash frames (< 3 frames), disabled clips, offline media, empty tracks, sequence end.',
    inputSchema: obj({ sequence: S.sequence }), fn: 'health' },
  { name: 'pr_copy_effects', description: 'Paste Attributes: copy added effects with their current values from one clip to others; includeMotion also copies Motion/Opacity values. Keyframes are not copied.',
    inputSchema: obj({ sequence: S.sequence, from: S.clip, to: { type: 'array', items: S.clip }, includeMotion: { type: 'boolean' } }, ['from', 'to']), fn: 'copy_effects' },
  { name: 'pr_save', description: 'Save the open project (Ctrl+S).', inputSchema: obj({}), fn: 'save' },
  { name: 'pr_eval', description: 'Run raw UXP JavaScript inside the panel (async function body; `ppro` = require("premierepro"), helpers in `h`). Return a JSON-able value. Only works when the user ticked "Allow raw scripts" in the panel. Use for API gaps, not routine edits.',
    inputSchema: obj({ code: { type: 'string' } }, ['code']), fn: 'eval' }
];

/* ------------------------------------------------------------------ */
/* Local tool implementations                                          */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = -1, stable = 0;
  for (;;) {
    let size = -1; try { size = fs.statSync(p).size; } catch (e) { size = -1; }
    if (size > 0 && size === last) { if (++stable >= 2) { return true; } } else { stable = 0; }
    last = size;
    if (Date.now() > deadline) { return false; }
    await sleep(60);
  }
}

async function exportFrames(args) {
  const times = (args.times || []).slice(0, 8);
  if (!times.length) { throw new Error('Pass at least one time.'); }
  fs.mkdirSync(FRAME_DIR, { recursive: true });
  for (const f of fs.readdirSync(FRAME_DIR)) { try { fs.unlinkSync(path.join(FRAME_DIR, f)); } catch (e) { /* locked */ } }
  const stamp = Date.now().toString(36);
  const res = await bridge('export_frames', { sequence: args.sequence, times, width: args.width, maxPx: MAX_IMAGE_PX,
    // Exporter.exportSequenceFrame on Windows rejects forward slashes (throws -1609629691); keep native separators.
    dir: FRAME_DIR + path.sep, prefix: 'f' + stamp });
  const content = [];
  for (const fr of res.frames) {
    const p = path.join(FRAME_DIR, fr.file);
    if (!fr.ok || !(await waitForFile(p, 20000))) {
      content.push({ type: 'text', text: 'Frame at ' + fr.seconds.toFixed(3) + 's: export failed' + (fr.error ? ' — ' + fr.error : '') });
      continue;
    }
    content.push({ type: 'text', text: 'Frame ' + fr.frame + ' (' + fr.seconds.toFixed(3) + 's), ' + fr.width + '×' + fr.height });
    content.push({ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType: 'image/png' });
  }
  return { content };
}

/* Text: the UXP API cannot set Source Text on graphics (needs an unexposed ArbData type), so render each line
   to a transparent full-frame PNG with Windows GDI+, import it into bin "MCP Text" and place it. */
function renderTextPng(file, w, h, r) {
  return process.platform === 'darwin' ? renderTextPngMac(file, w, h, r) : renderTextPngWin(file, w, h, r);
}

/* macOS: AppKit via JXA (osascript -l JavaScript). Same look as the Windows renderer. */
function renderTextPngMac(file, w, h, r) {
  const opts = JSON.stringify({ file, w, h, text: String(r.text || ''), font: r.font || 'Helvetica', size: Number(r.size) || 96,
    color: r.color || '#FFFFFF', stroke: r.stroke || null, bold: r.bold !== false, shadow: r.shadow !== false, y: r.y ?? 0.5 });
  const js = `
ObjC.import('AppKit');
function run(argv) {
  const o = JSON.parse(argv[0]);
  const hex = (s) => { const n = parseInt(String(s).replace('#', ''), 16); return $.NSColor.colorWithSRGBRedGreenBlueAlpha(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1); };
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, o.w, o.h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  rep.size = $.NSMakeSize(o.w, o.h);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.currentContext = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  const mkFont = (sz) => { let f = $.NSFont.fontWithNameSize(o.font, sz); if (!f || f.isNil()) f = $.NSFont.systemFontOfSize(sz);
    return o.bold ? $.NSFontManager.sharedFontManager.convertFontToHaveTrait(f, $.NSBoldFontMask) : f; };
  const maxW = o.w * 0.88;
  const longest = o.text.split(/\\s+/).sort((a, b) => b.length - a.length)[0] || o.text;
  let sz = o.size, font = mkFont(sz);
  while (sz > 20 && $(longest).sizeWithAttributes($({ NSFont: font })).width > maxW) { sz = Math.floor(sz * 0.92); font = mkFont(sz); }
  const para = $.NSMutableParagraphStyle.alloc.init; para.alignment = $.NSTextAlignmentCenter;
  const attrs = { NSFont: font, NSColor: hex(o.color), NSParagraphStyle: para };
  if (o.stroke) { attrs.NSStrokeColor = hex(o.stroke); attrs.NSStrokeWidth = -Math.max(2, sz / 30); }
  if (o.shadow) { const sh = $.NSShadow.alloc.init; sh.shadowOffset = $.NSMakeSize(0, -Math.max(3, sz / 18)); sh.shadowBlurRadius = sz / 12;
    sh.shadowColor = $.NSColor.colorWithSRGBRedGreenBlueAlpha(0, 0, 0, 0.55); attrs.NSShadow = sh; }
  const str = $.NSAttributedString.alloc.initWithStringAttributes(o.text, $(attrs));
  const boxH = o.h * 0.4, cy = o.h * (1 - o.y);
  const rect = str.boundingRectWithSizeOptions($.NSMakeSize(maxW, boxH), $.NSStringDrawingUsesLineFragmentOrigin);
  str.drawWithRectOptions($.NSMakeRect(o.w * 0.06, cy - rect.size.height / 2, maxW, rect.size.height), $.NSStringDrawingUsesLineFragmentOrigin);
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({})).writeToFileAtomically(o.file, true);
}`;
  require('child_process').execFileSync('osascript', ['-l', 'JavaScript', '-e', js, opts], { timeout: 30000 });
}

/* Windows: GDI+ via PowerShell. */
function renderTextPngWin(file, w, h, r) {
  const esc = (s) => String(s).replace(/'/g, "''");
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap ${w}, ${h}, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'; $g.Clear([System.Drawing.Color]::Transparent)
$style = [System.Drawing.FontStyle]::${r.bold === false ? 'Regular' : 'Bold'}
$sz = ${Number(r.size) || 96}
# Shrink until the longest word fits 88 % of the width, so words never break mid-word.
$longest = ('${esc(r.text)}' -split '\\s+' | Sort-Object Length -Descending | Select-Object -First 1)
do { $font = New-Object System.Drawing.Font('${esc(r.font || 'Arial')}', $sz, $style, [System.Drawing.GraphicsUnit]::Pixel)
  if ($g.MeasureString($longest, $font).Width -gt ${Math.round(w * 0.88)}) { $sz = [int]($sz * 0.92) } else { break } } while ($sz -gt 20)
$fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$rect = New-Object System.Drawing.RectangleF(${Math.round(w * 0.06)}, ${Math.round(h * (r.y ?? 0.5)) - Math.round(h * 0.2)}, ${Math.round(w * 0.88)}, ${Math.round(h * 0.4)})
$path.AddString('${esc(r.text)}', $font.FontFamily, [int]$style, $font.Size, $rect, $fmt)
${r.shadow === false ? '' : `$m = New-Object System.Drawing.Drawing2D.Matrix; $m.Translate(0, ${Math.max(3, Math.round((Number(r.size) || 96) / 18))})
$sp = $path.Clone(); $sp.Transform($m); $g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(140,0,0,0))), $sp)`}
${r.stroke ? `$pen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml('${esc(r.stroke)}'), ${Math.max(2, Math.round((Number(r.size) || 96) / 12))}); $pen.LineJoin = 'Round'; $g.DrawPath($pen, $path)` : ''}
$g.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('${esc(r.color || '#FFFFFF')}'))), $path)
$bmp.Save('${esc(file)}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()`;
  require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30000 });
}

async function placeTextPngs(args) {
  const info = await bridge('project_info', {});
  const seqs = info.sequences || [];
  const seq = (args.sequence && seqs.find((s) => s.name === args.sequence || s.guid === args.sequence)) || seqs.find((s) => s.active) || seqs[0];
  const [w, h] = (seq && seq.frameSize) || [1080, 1920];
  const projDir = String(info.path || '').replace(/^\\\\\?\\/, '').replace(/[\\/][^\\/]*$/, '');
  const dir = path.join(projDir || os.tmpdir(), 'MCP Text');
  fs.mkdirSync(dir, { recursive: true });
  const rows = args.items && args.items.length ? args.items : [{ text: args.text, at: args.at, duration: args.duration }];
  const files = [];
  for (const r of rows) {
    const slug = String(r.text).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 30) || 'text';
    const file = path.join(dir, slug + '-' + Date.now().toString(36) + '.png');
    renderTextPng(file, w, h, Object.assign({}, args, r));
    files.push(file);
  }
  await bridge('bin', { path: 'MCP Text' });
  await bridge('import', { files, bin: 'MCP Text' });
  const placements = rows.map((r, i) => ({ item: path.basename(files[i]), at: r.at || 0, track: args.track || 'V2', duration: r.duration || args.duration || 2 }));
  const placed = await bridge('place', { sequence: args.sequence, placements });
  return { files, placed: placed.placed || placed };
}

function statusInfo() {
  return {
    connected: !!panel, port: PORT, listening: !listenError, listenError,
    tokenFile: STATE_PATH, panel: panel ? panel.info : null, server: SERVER_VERSION
  };
}

async function runTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) { throw new Error('Unknown tool: ' + name); }
  let result;
  if (tool.local === 'status') { result = statusInfo(); }
  else if (tool.local === 'export_frame') { return exportFrames(args || {}); }
  else if (tool.local === 'text') { result = await placeTextPngs(args || {}); }
  else if (tool.local === 'captions') {
    const a = args || {};
    const plan = await bridge('captions', Object.assign({}, a, { dryRun: true, all: true }));
    if (a.dryRun) { result = { lines: plan.lines, preview: plan.preview.slice(0, 30) }; }
    else { result = await placeTextPngs(Object.assign({ size: 88, y: 0.72, stroke: '#000000' }, a, { items: plan.preview })); result = { lines: plan.lines, files: result.files.length }; }
  }
  else if (tool.heavy && !(args && args.dryRun)) {
    // RAM rule: renders are heavy. Refuse below 6 GB free or above 80 % used.
    const free = os.freemem() / 2 ** 30, used = 1 - os.freemem() / os.totalmem();
    if (free < 6 || used > 0.8) {
      result = { refused: 'Low RAM: ' + free.toFixed(1) + ' GB free, ' + Math.round(used * 100) + ' % used. Close something, or queue to Media Encoder later.' };
    } else { result = await bridge(tool.fn, args || {}); }
  }
  else { result = await bridge(tool.fn, args || {}); }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
}

/* ------------------------------------------------------------------ */
/* JSON-RPC over stdio                                                 */
/* ------------------------------------------------------------------ */

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const asked = params && params.protocolVersion;
    return reply(id, {
      protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Tools for a live Premiere Pro session through the Premiere MCP Bridge UXP panel. ' +
        'Read before editing (pr_project_info, pr_sequence_tree), look after editing (pr_export_frame), ' +
        'and read the sequence back after any edit — Premiere has no undo API, so each write is one Ctrl+Z step ' +
        'labelled "MCP: …" that the user can undo. Writes only go to the project the user marked as the sandbox in the panel.'
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') { return; }
  if (method === 'ping') { return reply(id, {}); }
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  }
  if (method === 'tools/call') {
    try { return reply(id, await runTool(params.name, params.arguments)); }
    catch (e) { return reply(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
  }
  if (method === 'prompts/list') { return reply(id, { prompts: [] }); }
  if (method === 'resources/list') { return reply(id, { resources: [] }); }
  if (method === 'resources/templates/list') { return reply(id, { resourceTemplates: [] }); }
  if (id !== undefined) { fail(id, -32601, 'Method not found: ' + method); }
}

function serve() {
  startSocketServer();
  let buffer = '', inFlight = 0, closed = false;
  const maybeExit = () => { if (closed && inFlight === 0) { process.stdout.end(() => process.exit(0)); } };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) { continue; }
      let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
      inFlight++;
      Promise.resolve(handleMessage(msg))
        .catch((e) => { if (msg && msg.id !== undefined) { fail(msg.id, -32603, e.message); } })
        .then(() => { inFlight--; maybeExit(); });
    }
  });
  process.stdin.on('end', () => { closed = true; setTimeout(maybeExit, 50); });
}

if (require.main === module) { serve(); }
module.exports = { TOOLS };
