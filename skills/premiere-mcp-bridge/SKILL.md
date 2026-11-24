---
name: premiere-mcp-bridge
description: Edit inside a live Adobe Premiere Pro project through the Premiere MCP Bridge (the pr_* tools) - read sequences, place and beat-cut clips, razor, ripple, roll, slide, slip and shift, effects with keyframes (zoom punches, blur, fades), transitions, audio gain, fades and ducking, audio effects, text and captions, bins, scene detection, transcripts, sequence settings, export and interchange. Turns the edit-* technique skills into tool calls. Use whenever a task touches the Premiere project that is open right now, or when a pr_* call is refused or fails.
---

# Premiere MCP Bridge

The `pr_*` tools edit the Premiere Pro the user has open, through a UXP panel
(the "Premiere MCP Bridge" panel). Reads show the real project. Writes change it
like a hand edit: each write is one or more Ctrl+Z steps labelled "MCP: …".
The user watches and tweaks in Premiere while you work.

```
pr_* tool ──stdio──► mcp/pr-mcp.js ──WebSocket 127.0.0.1:7790──► UXP panel ──premierepro API──► Premiere 27
```

Code: the `premiere-mcp` repo (see its README). API map and quirks: `docs/premiere-27-api.md`.

## Work like an editor

Never edit blind. Every job is **read → edit → look → check**.

1. **Orient**: `pr_status` (connected?), then `pr_project_info`, then `pr_sequence_tree` (with from/to/tracks to keep it short).
2. **Edit**: use the narrowest tool. Use `pr_eval` only for API gaps.
3. **Look**: `pr_export_frame` at the edited times (width 200–300 is enough). `pr_goto` to show the user the moment.
4. **Check**: `pr_health` for gaps, flash frames and offline media. Read the clips back with `pr_sequence_tree`.
5. **Risky or experimental edits**: `pr_sequence op:duplicate` first, and work on the copy (pass its guid as `sequence`).

Writes only go to the project the user marked as the sandbox in the panel.

## Clip references and time

- Clip: `{track:"V1", index:3}` (1-based, left to right) or `{track:"V1", at:12.5}` (the clip under that time).
- Time: seconds `2.5`, frames `"75f"` or timecode `"00:00:02:15"`. Always absolute. Relative strings like `"-0.5"` fail.
- Timecode uses the nominal frame rate (59 at 58.657 fps).

## Toolbar tools as calls

| Premiere tool | Call |
|---|---|
| Selection (V): move, trim | `pr_edit_clips` `moveTo`, `start`, `end` |
| Track Select Forward (A) | `pr_shift from by tracks`. It refuses overlaps. |
| Ripple Edit (B) | `pr_ripple_trim clip edge:head/tail to` |
| Rolling Edit (N) | `pr_roll track cut to` |
| Razor (C) | `pr_razor at:[…] tracks:["V1","A1"]`. Needs an empty track above for a moment. |
| Slip (Y) | `pr_edit_clips` `in` (keeps start and length) |
| Slide (U) | `pr_slide clip by` |
| Pen (P), keyframes | `pr_effect action:keyframes`, `pr_audio keys` |
| Type (T) | `pr_text` (transparent PNG, see Text) |
| Rate Stretch, Object Mask, Generative Extend, shapes | not in the API. Ask the user to do it by hand. |

## Technique skills as calls

- **Zoom punch** (edit-zoom-moves): `pr_effect keyframes` Motion › Scale `[{t:0,value:118},{t:0.35,value:100}]` bezier. For a slow push-in, use 100 → 108 over the clip.
- **Blur peak**: `pr_effect add effect:"Gaussian Blur"`. In Premiere 27 the param is **"Amount"** (not "Blurriness"). Keys 40 → 0 over 0.3 s.
- **Fade text or clip**: keyframe Opacity › Opacity.
- **Beat cut** (ae-audio-sync, edit-music-bed): earshot `timeline` gives the beats. Then `pr_beat_cut cuts sources end`.
- **J-cut** (edit-cut-pacing): `pr_razor` on the A track only, then `pr_roll` on the A track so the audio leads.
- **Remove silences**: `pr_transcribe`, then read the segments. Gaps between segments become `pr_razor` + `pr_remove ripple:true`.
- **Music ducking**: `pr_audio keys:[{t,db}]` (t from the clip start). Fade out: `pr_audio fadeOut:1.5`.
- **Muffle music** (edit-music-bed): `pr_effect add` on the A clip with `effect:"Parametric Equalizer"`, then `action:list` to find params.
- **Transitions**: `pr_transition name:"dip to black"|"cross dissolve"|"whip"|"film dissolve" at:end duration`. Adobe built-ins win over plug-in packs.
- **Same look on many clips**: `pr_copy_effects from to includeMotion`. It copies static values, not keyframes.
- **Captions** (edit-captions): `pr_transcribe item language` (en-us, hi-in…). It runs in the background, so poll with `action:read`. Then `pr_captions item offset wordsPerLine` (1 for word-by-word). Use `dryRun` first.

## Text

The UXP API cannot set the text of Premiere titles or MOGRTs. Their Source Text param needs an "ArbData" value the API does not expose; inserting works, but it shows "YOUR TITLE HERE". So `pr_text` and `pr_captions` render each line with Windows GDI+ into a transparent full-frame PNG. The files go to `<project folder>\MCP Text`, are imported into bin "MCP Text", and are placed (default V2). Style: `font` (Windows family), `size` px, `color`, `stroke` hex, `bold`, `shadow`, `y` 0..1. Animate the placed PNG with `pr_effect`. For editable designed titles, build them in After Effects (ae-typography) and export a MOGRT or a ProRes 4444 file.

## Audio

- Volume.Level is linear gain: **dB = 20·log10(v) + 15**, so 0 dB = 0.1778. `pr_audio` converts for you.
- Audio effects: `pr_effects_catalog audio:true`, then `pr_effect add` on an A-track clip (by display name).

## Export and delivery

See the `premiere-deliver` skill. In short: `pr_export preset:"h264-high" mode:"immediate"` works. Every export renders the **whole sequence**, because the API ignores the work area. The server refuses exports when RAM is low.

## Quirks (Premiere 27.0, probed live)

- Every action must be created inside `project.lockedAccess`. Actions in one transaction all see the state from before it, so dependent steps need separate transactions.
- `setInPoint`/`setStart` both trim the head. `setOutPoint`/`setEnd` both trim the tail. `createMoveAction` is relative.
- Keyframe positions are **source** times (clip in point + offset). `pr_effect` and `pr_audio` take t from the clip start and convert.
- `createCloneTrackItemAction(item, dt, dVideoTracks, dAudioTracks, alignToVideo, isInsert)` copies a clip. Razor is built on it.
- Tracks cannot be added or deleted. Clip speed cannot change. Color Mode (27.0) has no API; grade with Lumetri (premiere-color).
- `exportSequenceFrame` needs backslash folders. A frame past the end of the video shows as grey (empty).
- `SequenceUtils.performSceneEditDetectionOnSelection(operation, trackItemSelection)`: other argument orders throw.
- `Transcript.transcribeClipProjectItem(item, languageObject)`: pass the object from `querySupportedLanguages`, not the code string. It is fast (a few seconds for a short clip).
- Captions offset = the clip's timeline start minus its source in point. Use `from` to keep only the lines over the visible part of the clip.
- `createSubClipAction(name, in, out, hardBoundaries)`: 4 args.
- FCP XML export opens a modal dialog in Premiere. The user must click OK, or the call hangs.
- Text PNGs: `pr_text` shrinks the font until the longest word fits 88 % of the frame width (no mid-word wraps). Pop-in: Scale 85→100 over 0.3 s plus Opacity 0→100 over 0.2 s.
- Placing a clip with linked audio on a new audio index creates a track; `pr_place` reuses empty audio tracks.

## When something fails

- "not connected": ask the user to open the panel (Window ▸ UXP Plugins) or reload it in UXP Developer Tools.
- A new tool is missing: the server is stale. Ask the user to run `/mcp` and reconnect `premiere-pro`.
- Panel code changed: the user must click Reload in UXP Developer Tools.
- "Refused: raw scripts are off": `pr_eval` needs "Allow raw scripts" ticked in the panel.
- A param name is not found: `pr_effect action:list` shows the real names (they change between versions).
