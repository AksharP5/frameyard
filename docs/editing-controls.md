# Editing controls

The left rail contains Media, Timeline, and the canvas tools. Media opens the
project library; in narrow windows it overlays the preview instead of squeezing
it. The right workspace shows buttons for Properties, Assistant, catalogs, and
editing panels. Hide the workspace with the sidebar button in the project header.
The playback controls stay centered below the preview when panels change.

## Keyboard

These shortcuts apply outside text fields and menus.
Tab moves between controls. Space or Enter activates a focused button; Space on
Manim's Play button controls that preview without starting the main timeline.
Move and Hand are separate canvas buttons, with V and H shortcuts.

| Key | Action |
| --- | --- |
| E | Razor: split at the playhead |
| Q | Start to Playhead: trim the selected clip's left side |
| W | End to Playhead: trim the selected clip's right side |
| Delete / Backspace | Delete selected layers or frames, leaving a gap |
| X | Delete selected, leaving a gap |
| Shift+X | Ripple delete selected |
| Z | Zoom viewer to fit |
| Ctrl+Z | Undo |
| Ctrl+E | Export active scene or marked range |
| Ctrl+Shift+E | Export the current frame as an image |

Razor splits selected clips that cross the playhead. With nothing selected, it
splits clips under the playhead. Q and W preserve the remaining media's source
timing and do nothing at or outside a clip's boundaries.

Ripple delete closes the removed intervals in the same track/container and its
linked or sync-locked tracks. Each keyboard edit can be undone in one step.

Linked video and audio move, trim, split, and delete together. `Ctrl+L` links
selected clips; `Ctrl+Shift+L` unlinks them. `Alt`-click selects one partner for
independent editing. Locked tracks protect their children from edits.

Clicking the canvas or timeline gives it keyboard focus, so Delete acts on the
selection after editing an input. Delete inside a text field still edits text.
Reopening uses the selection saved in the current source. A live source reload
keeps the current selection, including an empty selection.

## Text

Select a text layer to open Properties. Its words, font, size, and color appear
first. Double-click text to focus its content field. Text with paint layers uses
the Fills controls directly below Text; plain text has a Color control in Text.

## Timeline and marked range

Selecting a frame or a layer in another frame switches to that frame's timeline
and reveals it if collapsed. Each frame keeps its own playhead.

Hold the middle mouse button and drag left or right to pan the timeline.
Alt+scroll zooms around the pointer.

Double-click a layer name or choose **Rename** from its context menu. Enter or
clicking elsewhere commits the name in one undo step; Escape cancels it.

The speaker button beside Play opens playback volume and mute. It stays visible
when the timeline is collapsed. Playback volume affects monitoring only.

The mode menu selects Trim, Ripple, Roll, Slip, or Slide. The More
menu contains project frame rate, source matching, markers, and range controls.
Frame stepping and four-part timecode use the project rate.

Select a media asset to open its Source viewer. Mark In/Out with the buttons or
focused I/O shortcuts, then Insert or Overwrite onto the target track. Source
marks are saved with the project.

Hold Shift and drag across the time ruler to create the blue playback/export
range. Drag either handle to resize it; drag the bar to move it. The range snaps
to clip cuts and the playhead, including selected clips. Double-click the bar to
clear it. In Assistant, **Time range → Use timeline range** attaches those exact times
to your request.
Starting playback outside the marked interval begins at its start on the first
press of Play, Space, or L. J starts reverse playback at the end of the marked
interval when the playhead is outside it or at its start.

Drag the workspace divider, timeline top edge, or layers divider to resize.
Resizing a panel keeps the same start and end times visible in the timeline.
Resizing or reopening the app window keeps the saved timeline zoom.
Your playhead, marked range, and clip timings stay unchanged. Properties,
Assistant, and catalogs stay available in the right workspace.
Small tiled windows scroll the workspace instead of blocking editing. Widen the
window to see the full workspace at once.

## Effects

TV Power Off's Start frame and Collapse duration use project frames, so changing
export fps keeps the same timing. Existing effects authored in seconds keep
their seconds controls. Afterglow controls the picture glow and final phosphor
dot. Pixelate Region starts with two horizontal areas; choose either area in
Properties to reposition it.

Call Out's Animate in control uses project frames and defaults to 36. Existing
Call Outs authored in seconds retain their seconds control. Pointer animations
use seconds and keep their speed when the clip is shortened.

CCTV starts with a static timecode and no record light, matching the source.
Enable Run clock or Record light in Properties to animate them. Saved CCTV
effects retain their running clock and light.

## Export

Click **Export** in the project header, then **Export scene...** and
choose the destination. Ctrl+E does the same. The default is an MP4 video.

When a blue range exists, the command reads **Export marked range...** and only
exports that interval. Clear the range to export the whole scene.

To choose resolution, frame rate, codec, and audio settings, select the scene,
open **Properties**, and add or edit its **Export** entry. Quick Export, Ctrl+E,
File menu export, the inspector, and CLI export all use these saved settings.
Without saved settings, export uses MP4 and the project frame rate. Invalid
container/codec combinations show an error before rendering.

Preview quality can be Source, Half, or Quarter. Export decodes the original
media, independent of the preview copy. The FPS and skipped-frame readout measures
uninterrupted normal-speed playback; it resets after seeks, loops and buffering.
The decoding warning applies only to visible video in the active scene.
Rendering is 8-bit SDR. Preview may use a cached H.264 copy for a source the browser cannot decode, but export reads the original file. [Linux media limits](linux.md#media-limits) covers unsupported source formats.

## Saving and media

Asset arrow keys and Delete apply to the focused asset grid. Search, filters,
and folder changes clear any selection they hide. Backspace in a folder with
no selected asset returns to its parent; Delete in a text field edits text.

The project header's save status covers source edits and the asset manifest. Click
**Unsaved changes** to retry a failed save. Source recovery can be downloaded
before explicitly discarding unsaved edits. Recovery checkpoints are made every
five minutes after saved edits; the latest ten automatic checkpoints are kept
alongside manual checkpoints.

File → Asset → **Find missing media** searches a chosen folder and lets you
review replacement paths. **Collect project media** copies originals into the
project and updates its references. Originals are preserved.

## Finishing

Soloing a group includes its nested audio; explicit mutes still apply.
The Audio inspector provides stream selection, pan, three-band EQ, compressor,
and a sample-peak limiter. The scene's master audio controls can measure and
normalize the complete mix with a true-peak headroom constraint.

Select an image, video, or scene for white balance and master/RGB curves. The
Color inspector also provides waveform, histogram, and vectorscope views. Clip grading runs before object fit and effects; scene grading runs after its child content. The limiter sets a sample-peak ceiling, not a true-peak guarantee, and the scopes are editing aids rather than calibrated broadcast instruments.
