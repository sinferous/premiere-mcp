---
name: premiere-color
description: Colour grade in Premiere Pro through the Premiere MCP Bridge - Lumetri Color on clips or across many clips (exposure, contrast, temperature, tint, saturation, vibrance, faded film, sharpen, vignette), matching shots by eye with exported frames, copying a grade to other clips, and what the new Premiere 27 Color Mode can and cannot do from scripts. Use when asked to grade, colour correct, make it warmer, cooler, moodier or punchier, match shots, or fix dark, flat or washed-out phone footage in Premiere.
---

# Premiere colour via the bridge

Uses the `pr_*` tools (see premiere-mcp-bridge).

## Color Mode vs Lumetri

Premiere 27.0 has a new **Color Mode** workspace (Adjust layers, Sequence Styles, LUTs). No UXP API reaches it: no class, no component on the clip. Scripts grade with the **Lumetri Color** effect (`AE.ADBE Lumetri`). Lumetri stays supported, and the user can still refine the grade by hand in Color Mode.

If the user grades in Color Mode by hand, do not stack a strong Lumetri grade on top. Ask which one leads.

## Workflow

1. **Look first**: `pr_export_frame` at 3–6 times across the sequence (width 240). Name what is wrong: too dark, too blue, flat, clipped, or a mismatch between shots.
2. **Add Lumetri** to one hero clip: `pr_effect action:add effect:"Lumetri Color" clips:[…]`.
3. **Find the param names**: `pr_effect action:list` on that clip. Lumetri has many params, and the names (Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temperature, Tint, Saturation, Vibrance, Faded Film, Sharpen, Vignette Amount…) are what you pass as `param`. Use them exactly as listed.
4. **Set values**: `pr_effect action:set params:[{component:"Lumetri Color", param:"Exposure", value:0.4}, …]`.
5. **Look again**: `pr_export_frame` at the same times. Compare with the earlier frames.
6. **Spread it**: `pr_copy_effects from:<hero> to:[…]`. It copies the static Lumetri values. Then fix outliers one by one.

## Lumetri param indices (Premiere 27.0, verified)

Names repeat (two Saturation, Contrast, Sharpen and Temperature params), so set by **index**:
14 Temperature · 15 Tint · 16 Saturation (Basic) · 19 Exposure · 20 Contrast · 21 Highlights · 22 Shadows · 23 Whites · 24 Blacks · 40 Faded Film · 41 Sharpen · 42 Vibrance · 43 Saturation (Creative) · 110 Vignette Amount · 111 Midpoint · 113 Feather.

Verified "vibrant" look (phone travel reel, 2026-11-24): 14:+4, 16:118, 20:+20, 21:-12, 22:+12, 23:+12, 24:-14, 41:15, 42:+30, 110:-0.5. Apply with one `pr_effect action:set` over all clips. Its output is large, so expect a saved-file result.

## Starting values for phone footage (adjust by eye)

| Problem | Lumetri change |
|---|---|
| Night street, too dark | Exposure +0.3 to +0.6, Shadows +15, Blacks -5 (keep contrast) |
| Flat, washed out | Contrast +15, Whites +10, Blacks -10, Vibrance +15 |
| Too blue / cold LEDs | Temperature +8 to +15 |
| Green cast (fluorescent) | Tint +5 to +10 |
| Oversaturated signs | Saturation 85–90, Vibrance +10 |
| Cinematic, soft | Faded Film 10–20, Contrast +10, Vignette Amount -0.8 |
| Soft image | Sharpen 15–25 (not more: phone noise) |

Small steps. Keep skin natural. Check the brightest signs and lights for clipping in the frame export.

## Grade with movement

All Lumetri params can be keyframed: `pr_effect action:keyframes`, for example Exposure pulsing on a beat drop, or Saturation 0 → 100 for a colour reveal.

## Limits

- No LUT browsing through Color Mode. Lumetri's Input LUT is a file path param; set it only if `action:list` shows it as settable.
- No scopes from the API. Judge with exported frames and the user's eye.
- `pr_copy_effects` does not copy keyframes.

Log the final values per look in the project note, so the grade can be repeated.
