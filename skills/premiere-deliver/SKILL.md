---
name: premiere-deliver
description: Deliver a finished Premiere Pro edit through the Premiere MCP Bridge - pick the export preset per platform (Instagram Reels, TikTok, YouTube Shorts, YouTube, master ProRes, audio only), render with pr_export, check the file with ffprobe, measure loudness with earshot and hand off OTIO, FCP XML or AAF. Use when asked to export, render, deliver, make the final file, or prepare versions for platforms.
---

# Premiere delivery

Uses the `pr_*` tools (see premiere-mcp-bridge). Exports are heavy: follow the RAM rule.

## Before you render

1. `pr_health`: there must be no gap at the start, no flash frames and no offline media. Fix them first.
2. `pr_sequence op:settings`: check the frame size and frame rate. Phone footage is often 58.657 fps. Platforms accept it, but ask the user before conforming it.
3. Check RAM: `(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB`. You need 6 GB free or more and usage at 80 % or less. The server also refuses below that.
4. Save: `pr_save`.

## Presets

| Target | `pr_export preset` | Notes |
|---|---|---|
| Reels / TikTok / Shorts (9:16) | `h264-high` | Match Source, high bitrate. 1080×1920. Upload limit is fine below 4 GB. |
| Review copy, quick share | `h264-medium` | About 25 Mbps at 1080×1920. |
| YouTube 16:9 | `h264-high` | Or `hevc` for 4K. |
| Master / archive / grading handoff | `prores-hq` | Large files. |
| Audio only (music, VO review) | `wav` / `mp3` / `aac` | |
| Image sequence, GIF | `png-seq`, `gif` | |
| Custom | full `.epr` path from `pr_export_presets query` | |

Output defaults to `<project folder>\Exports\<sequence>.<ext>`. Give `output` to name versions (`…\Exports\<name> v2.mp4`), and never overwrite an earlier delivery without asking.

## Render

- `mode:"immediate"` (default): Premiere renders now and is busy until it finishes. Verified.
- `mode:"ame"`: Media Encoder renders in the background, so the user can keep editing. Media Encoder takes about 2.6 GB of RAM. Verified that it queues the job.
- Premiere's own queue (QUEUE_TO_APP) returns false in 27.0, so it is not offered.
- The API ignores the work area: **every export renders the whole sequence**. For a short excerpt, duplicate the sequence (`pr_sequence op:duplicate`) and cut the copy down to that part.
- Progress: `pr_export_status`.

## Check the file

```powershell
ffprobe -v error -show_entries format=duration,bit_rate:stream=codec_name,width,height,r_frame_rate -of compact "<file>"
```

The duration must match `pr_health` sequenceEnd. The size must be 1080×1920 for 9:16. The video codec is h264 and the audio codec is aac.

Loudness: earshot `measure` on the file. Social target: about -14 LUFS integrated, true peak -1 dBTP or lower. If it is too quiet or loud, change it with `pr_audio gain` on the music or VO and render again.

Look at it: `pr_export_frame` at the first frame, the drop, and the last second (a dip to black shows grey past the end).

## Handoff to other apps

`pr_interchange format:otio|fcpxml|aaf` (all three verified). **FCP XML opens a "Translation Report" dialog in Premiere that blocks the call: ask the user to click OK.** The report (`FCP Translation Results <date>.txt` next to the XML) lists effects FCP cannot carry, such as blur and audio EQ. FCP XML opens in DaVinci Resolve. AAF goes to Pro Tools or Avid.

## After delivery

Log the file name, preset, duration and loudness wherever the project keeps its notes.
