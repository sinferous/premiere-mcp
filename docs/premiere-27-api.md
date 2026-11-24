# Premiere Pro 27.0 UXP API — live map (probed 2026-11-24)

The `premierepro` module exposes 73 classes. This file records what each area can do,
the quirks found by probing a live session, and which bridge tool covers it.

## Coverage

| Area | API | Bridge tool | Status |
|---|---|---|---|
| Project read, sequences | `Project.getSequences/getActiveSequence`, `Sequence.*` | pr_project_info, pr_sequence_tree | verified |
| Bins | `FolderItem.getItems`, `createBinAction`, `createMoveItemAction`, `createRemoveItemAction`, `createRenameBinAction` | pr_list_items | read verified; create/move not built |
| Import | `Project.importFiles` | pr_import | verified (target bin must exist) |
| Place / trim / move / remove | `SequenceEditor.*`, track item `createSet*Action`, `createMoveAction`, `createRemoveItemsAction` | pr_place, pr_edit_clips, pr_remove, pr_beat_cut | verified |
| Clone clip (razor emulation) | `SequenceEditor.createCloneTrackItemAction` | — | not built |
| Markers | `Markers.*`, `Marker.createSet*Action` | pr_markers | verified |
| Frame preview | `Exporter.exportSequenceFrame` | pr_export_frame | verified |
| Playhead | `Sequence.setPlayerPosition` | pr_goto | verified |
| Effects (video) | `VideoFilterFactory.createComponent(matchName)`, `VideoComponentChain.createAppend/Insert/RemoveComponentAction` | pr_apply_effect | untested |
| Effect params + keyframes | `Component.getParam(i)` → `createSetValueAction`, `createSetTimeVaryingAction`, `createKeyframe`, `createAddKeyframeAction`, `createSetInterpolationAtKeyframeAction`, `getKeyframeListAsTickTimes`, `getValueAtTime` | — | not built |
| Built-in Motion / Opacity | component 0 `AE.ADBE Opacity` (Opacity, Blend Mode), component 1 `AE.ADBE Motion` (Position [0.5,0.5 normalised], Scale, Scale Width, Uniform, Rotation, Anchor Point, Anti-flicker, Crop L/T/R/B) | — | read verified |
| Effects (audio) | `AudioFilterFactory.createComponentByDisplayName`, `AudioComponentChain.*` | — | not built |
| Transitions | `TransitionFactory.createVideoTransition(matchName)`, `VideoClipTrackItem.createAddVideoTransitionAction(t, AddTransitionOptions)` | — | not built |
| Text / titles | `SequenceEditor.insertMogrtFromPath/Library`, `MogrtText.setText/setFontName/setFontSize…` | — | not built |
| Captions / transcript | `Transcript.transcribeClipProjectItem`, `exportToJSON`, `importFromJSON`, `createImportTextSegmentsAction`; `Sequence.getCaptionTrack` | — | not built |
| Scene cut detection | `SequenceUtils.performSceneEditDetectionOnSelection(APPLYCUT/CREATEMARKER/CREATESUBCLIP)` | — | not built |
| Export | `EncoderManager.getManager().exportSequence/encodeFile/encodeProjectItem` (IMMEDIATELY / QUEUE_TO_AME / QUEUE_TO_APP) | — | not built |
| Sequence settings | `SequenceSettings.*`, `Sequence.createSetSettingsAction`, `Project.createSequence*` | — | not built |
| Work area | `WorkAreaUtils.*` | — | not built |
| Source monitor | `SourceMonitor.openProjectItem/openFilePath/setPosition/play` | — | not built |
| Clip project item | proxies, LUT, colour label, interpretation, subclips, offline | — | not built |
| Metadata | `Metadata.*` (project + XMP) | — | not built |
| Interchange | `ProjectConverter.exportAAF/exportAsFinalCutProXML/exportAsOpenTimelineIO`, `Project.importAEComps` | — | not built |
| Preferences | `AppPreference` — only 3 keys (auto peak, import workspace, quickstart dialog) | — | general preferences are NOT exposed |

## Not in the API

Delete tracks, add tracks directly, razor, ripple-trim tools, speed/duration change (read-only `getSpeed`),
audio clip volume except through the Volume component, Essential Sound panel, auto-ducking, Enhance Speech,
Generative Extend (only a completion event), workspaces, keyboard shortcuts, most preferences.

## Catalogue in this install

- 118 video transitions (Adobe built-ins, Mettle SkyBox, Impact pack).
- 115 video effects: Lumetri Color, Warp Stabilizer, Transform, Gaussian Blur, Camera Shake, Directional Blur, Ultra Key, Vignette, Noise, Sharpen…
- 55 audio effects: Parametric Equalizer, Studio Reverb, DeNoise, DeReverb, Dynamics, Hard Limiter, Multiband Compressor, Loudness Meter…
- Transcription languages: 18, including English, Hindi.
- Media Encoder and After Effects are installed.
- MOGRT folder: `%APPDATA%\Adobe\Common\Motion Graphics Templates\`.

## Quirks (Premiere 27.0)

- `Exporter.exportSequenceFrame` rejects forward-slash folders (throws -1609629691).
- Action objects must be created inside `project.lockedAccess`.
- All actions in one `executeTransaction` see the state from before it; dependent steps need separate transactions.
- `setInPoint`/`setStart` both trim the head; `setOutPoint`/`setEnd` both trim the tail; `createMoveAction(delta)` is relative.
- `TrackItemSelection.createEmptySelection()` rejects no-arg and Sequence args; use `seq.clearSelection()` + `seq.getSelection().addItem()`.
- `ClipProjectItem.getMedia().duration` returned null for phone MP4s.
- Placing a clip with linked audio on a new audio index creates a track; tracks cannot be deleted.
