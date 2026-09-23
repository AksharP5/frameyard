# Agent workspace

Open a project. The right workspace starts with **Properties** for selected
layers and **Assistant** for chat. Choose **Codex** or **Claude Code** with the
**Agent** selector. The header's **Assistant** button opens
the same conversation. All panels have visible buttons at the top of the workspace:

- **Animations:** create with HyperFrames or Manim, preview saved animations,
  revise in chat, and export. **Add at playhead** places one in the active scene.
- **HyperFrames**, **Templates**, and **Hyfrme:** browse
  reusable scenes, effects, and complete videos. Preview an item and attach it to Assistant.
- **Effects**, **Transcript**, **Audio**,
  **Checkpoints**, or **Find assets**. Adjust layers, apply effects, edit speech,
  mix audio, restore project files, or search for images and logos.

The workspace remembers your selected panel. Hiding it preserves the conversation
and unsent draft. Search
fields have a clear button; Escape clears a search while keeping keyboard focus.
In **Find assets**, **Add to assets** imports an image and **Add to timeline**
places it at the playhead. **Ask Codex to find** and **Generate image** prepare a
chat request you can edit and send.

Open **Media** in the left rail and click an image for a larger preview. Press Escape or
click outside to close. Hover a video for muted playback; leaving the tile stops it.

## Chat agents

Codex and Claude Code share the upstream message view and composer. Each keeps
its own project conversations. Switching agents preserves the unsent Codex draft.
The dashboard's Send button starts a conversation in the selected agent and opens
Assistant in that project.

Codex keeps the native sessions and context tools described below. Claude Code
uses upstream chat history, model selection, questions, and file attachments.
Area notes, time ranges, skills, effect references, and transcript or video
attachments use Codex. Attaching one from a workspace panel selects Codex.

Both agents save a project checkpoint before a new turn. A project can run one
agent turn at a time. Stop that turn before restoring a checkpoint.
Claude checkpoints are available in **Checkpoints**; **Undo last turn** belongs
to the native Codex conversation. Sign in through each installed agent's CLI.

## Codex and context

Install and sign into the Codex CLI with `codex login` before using Assistant. If Assistant
already shows the login notice, choose **Check login** after signing in. This
integration uses Codex app-server over local stdio. Credentials stay with Codex;
there is no separate API-key field. The model and reasoning controls below the composer use the options reported by
your installed Codex CLI. They initially reflect your configuration or resumed
thread; changes apply on the next send and persist in that native thread.
The selected conversation, unsent draft, attachments, and workspace tab survive
reopening the project or restarting Frameyard. Drafts and attachments also survive
project renames. Drafts are saved locally per project and clear only after a successful send. Attachments can be sent without additional text.
Replies format Markdown, code blocks, lists, and tables. Hover a message to copy
it. The composer grows with your draft; Enter sends and Shift+Enter adds a line.
Type `$` to search installed skills in Home or Assistant with Codex selected.
Choose a suggestion with the mouse, Enter, or Tab to attach that skill's native
name and path. Escape closes suggestions. Removing the `$name` mention also
removes its attachment. **Add context** opens image and editor context tools.
While Codex is working, Enter or **Steer Codex** sends new direction to the same
active turn with fresh selection and playhead context. **Stop** remains separate.
Steering does not create another checkpoint or restart the turn. If the turn ends
before the message arrives, the draft stays available to send as a new turn.
Model and reasoning changes apply between turns.
Assistant remains available with unsaved or recovered edits, including when saving fails.
Messages include the current editor context and save status. The automatic checkpoint
contains the files already on disk; unsaved edits remain in the editor recovery copy.

Project source changes reload the preview and timeline automatically while the
agent works, including during ongoing renders. The playhead and surviving
selections are retained. Invalid source keeps the last successful preview until
the source is fixed. Unapplied recovery edits remain available while saved source
updates reload; live edits must finish saving before the preview can be replaced.
Reopening a project also waits for its previous save to finish. Folder aliases
resolve to one project, carrying over its remembered entry and recovery edits.
If both paths have different recovery copies, opening stops and keeps both copies.
Restoring an alias's recovery copy also requires closing that project's current
editor first, so a later save cannot erase the recovered edits.

After a turn, **Undo last turn** restores the project files saved before it.
This also replaces later manual edits; the confirmation explains that scope.
Current files are saved in **Checkpoints** first, so you can recover them.
The timeline reloads without clearing your chat draft or attachments. Undo is
available for the latest Frameyard turn in that conversation, including a stopped
or failed turn, and survives reopening Frameyard. Finish the active turn before
undoing it. Native chat history is retained.

You can prepare attachments while a turn runs. Use **Attach images**, paste an
image, drop image files into the composer, or choose **Attach selected image**
for an image selected in Assets. PNG, JPEG, WebP, and GIF are supported, up to
four images, 10 MiB each and 20 MiB total. Images remain in the draft until you
send them through Codex.

**Mark area**, **Time range**, video context, transcript preparation/attachment,
and effect references remain available while Codex works. You can revise or
remove draft attachments before sending a steer. Captures are frozen references;
if the scene changes during a capture, prepare that reference again. A rejected
send retains its attachments. A successful send clears only what it submitted.

**Add context > Skills and MCPs** lists enabled skills and configured MCP servers from local
Codex. Choose a skill to attach its exact native name and path, then send it with
or without further instructions. You can also name skills and tools in your
message. MCP tools run through Codex's existing server connections. Frameyard does
not replace your Codex configuration or install missing tools.

Native questions, permission requests, and MCP forms appear above the composer.
Answer them there to continue. Answers stay in place when another request arrives.
MCP URL requests open only when you click their
link; return and choose **Done** after completing the external step. Unsupported
MCP form schemas display an error and can be declined. This is a native Codex
thread, but Frameyard does not reproduce every terminal slash command or account
and plugin management screen. **Copy resume** continues it in the terminal.

Editing requests and attached context are sent through your Codex
account; the model itself does not run offline.

Existing CLI sessions keep their native tools. They can reach the same editor,
asset, and catalog operations through `dapi tool <name> --args '<JSON object>'`.
For example: `dapi tool asset_search --args '{"query":"OpenAI","kind":"logo"}'`.
Run `dapi tool --help` for syntax; use `dapi capture` for image files.
MCP `agent_tool` returns captures as image content and marks editor failures with
`isError`. The CLI preserves the structured failure JSON and exits unsuccessfully.
Animation render, conversion, and export calls accept cancellation; `dapi tool`
allows up to one hour for these operations. Cancellation prevents queued work
from starting but does not undo completed edits. Already dispatched editor edits,
asset downloads, and catalog installs finish before releasing the project lock.
Edits to locked content fail without changing it. Unlock the layer before editing;
an update that adds a new lock applies its other changes first. Captures use the
project frame rate and stop remaining frames when canceled. CLI commands release
their MCP sessions when they finish.
Scene exports accept cancellation while saving edits or preparing the renderer.
Canceled or failed exports preserve the existing destination file and remove
temporary output. Only one scene export runs at a time.

Each project remembers its current native Codex thread. Closing and reopening the
app restores its messages and model context. **Sessions** lists existing local
conversations for the same project folder; **New session** (+) starts another conversation
without deleting the old one. A failed resume is shown as an error instead of
silently replacing the thread. The project-to-thread mapping lives under
`~/.config/Frameyard/codex-projects/` on new installations. Existing installations
keep `~/.config/Diffusion Studio Linux/codex-projects/`. Native history stays in Codex.
Choose **Copy resume** and paste the command into your terminal to continue the
same session outside Frameyard. The command keeps its project folder, model, and
reasoning. Copying releases Frameyard’s idle Codex connection so the terminal can
open the session; no history is deleted. Finish active turns before handing off.
`codex resume --all --include-non-interactive` also lists sessions across folders.
After closing the terminal session, send another message in Frameyard to continue;
Frameyard reloads the conversation, including terminal messages.

Long conversations open at the latest 60 messages; **Load earlier messages** reveals
more. Scrolling up holds your place during a reply; **Jump to latest** resumes
following. Catalog attachments and **New animation** preserve your unsent draft.

If a rename moves the project folder, Frameyard reloads Assistant for that folder and
keeps the project's unsent draft and attachments. Native sessions remain saved under their original
working directory; Frameyard does not present their history as a new conversation.
A rejected send keeps its draft and attachments without adding an unsent message
to the conversation.

At send time the agent receives the project folder, active scene, playhead,
selected elements with their source IDs and properties, selected library asset,
and up to 100 library entries. Selection is the referent for requests such as
“move this right.” The agent can request fresh context or a rendered frame while
working. Changing projects makes live editor tools reject requests from the old
project. Select the intended item and send another message to update the context.

Use **Assistant → Mark area** to pause and capture the active scene. Drag a rectangle
on the frame, add a note such as “blur this out” or “zoom into this,” then choose
**Attach area** and **Send**. Click the attachment thumbnail to revise it, or
the attachment's remove button to discard it. Marking alone does not send a
request or edit the video. The captured frame includes unsaved visual edits and
shows the whole scene even when the preview is zoomed or panned. Saving is not
required to mark an area.

The agent receives the outlined image, scene ID, original time/frame, normalized
rectangle, scene dimensions, note, and selection at capture time. Moving the
playhead afterward keeps the reference attached to the original frame. The area
is spatial context. Use **Time range** beside **Mark area** to attach start/end
times in seconds, snapped to scene frames. A range already marked by Shift-dragging
the timeline ruler is offered automatically; you can also enter exact times.
The timeline range controls playback/export too. Attaching or entering times in
Assistant does not change it. Combine area and range attachments with “black this out”
to limit the cover to that region and interval. The range stays frozen if you move
the playhead, and its end is exclusive. Click the range to revise it or remove it
with its × button. Ranges can extend beyond the current scene duration. When adding
a template or asset, the agent uses the range start as its insertion time and
keeps the full clip duration, extending the scene as needed. Ask explicitly to
fit or trim the clip if you want it confined to the interval. Area and range must refer to the same scene. Blur and zoom are agent editing requests, so inspect the result before
exporting. The frozen image stays in the native Codex conversation after sending;
unsent area drafts are saved locally with the chat draft.

Use **Assistant → Transcript** or **Transcript**, then **Generate transcript**.
Local Whisper transcribes all speech in the active scene, including speech outside
a marked playback/export range. **Attach to chat** attaches the saved word-timestamp
JSON file. Codex receives its path and scene identity so it can read the whole
transcript. Attaching does not add captions or change clips.

Click a word to seek. Edit it with **Save word**, keeping its original timing.
**Apply captions** adds full-scene captions or updates existing captions while
preserving their style. Later word corrections update captions linked to that
transcript. Corrections stay in project assets and reopen with the project.
Existing captions with custom timing or nesting need to be removed before applying
a new full-scene transcript.
Word corrections leave separately timed automatic captions alone. Unlock linked
captions before changing their transcript.

Click a sentence timestamp, or Shift-click another word, then **Cut selection**.
The selected time is rounded outward to video frames, removed from every track,
and the gap closes. Ordinary media, overlays, source offsets and keyframes are
preserved. The cut is one undo step and saves a project checkpoint first.
Cuts affecting locked clips, crossing groups, nested scenes, preset animations or transitions, and clips
with loops, automatic sync or dynamic properties are rejected before changing
files. Scenes and sequences with their own source trims or playback timing need
to be simplified first. After a cut or another scene edit, **Regenerate** before
using the transcript again. An edit during transcription discards the result.

Use **Assistant → Video context** to attach the full transcript plus up to 12 sampled
frames of the active scene, including both sides of representative clip boundaries.
The frames show the composited video with its existing text, captions and overlays.
Silent scenes still provide images. Preparing context does not add or move clips.
Codex receives the images with explicit scene timestamps and can inspect an exact
moment with `editor_capture` using `sceneId` and `time` in seconds. Existing terminal
sessions can inspect saved PNGs or use `dapi capture --scene-time` for closer checks.

This is a sampled overview, not exhaustive frame-by-frame analysis. Ask the agent
to check the relevant word and surrounding frames before placing an animation.
Context files remain in `.diffusion/video-context/` and can be read after resuming
the same Codex session outside Frameyard. Attach fresh context after editing the video.
Transcription and frame capture run locally; visual analysis uses your selected
Codex model and normal Codex account. Long transcripts process short overlapping
audio windows one at a time and retain scene timestamps. Large source files are
read in finite slices, and temporary audio is removed after each window.

Basic property/text edits and asset insertion use the editor's normal undo
history. Larger changes use editable project files and trigger recompilation.
**Checkpoints** retain source edits across recompiles without requiring Git.
Frameyard saves one before each Assistant turn and before transcript corrections, caption
application and cuts. If saving fails, the turn or edit does not start. Name and
**Save** a checkpoint whenever you want to keep the current version.

**Restore** first saves the current project as a recovery checkpoint, then restores
source and project assets, including deleted files. Files added after the chosen
checkpoint are removed. The editor reloads to clear stale media and undo state;
unsent chat drafts and attachments stay. Choose the recovery checkpoint to undo
the restore. Native Codex conversations remain in their normal history.

Background recovery also runs after edits. If saving fails, it still snapshots the
files on disk and stores the pending edit journal and save errors separately in
`editor-recovery.json` beside the checkpoint manifest. Restoring a checkpoint does
not automatically replay that journal. The editor keeps its existing recovery
copy available through **Unsaved changes**.

Checkpoints live in `.diffusion/checkpoints/` inside the project and reuse unchanged
media. Only regular project files are captured. Symlinked or external media,
`.git`, dependencies, virtual environments, caches, temporary animation output,
and private `.diffusion` state are excluded. Empty directories are not retained.
Checkpoints cannot run during an active Frameyard agent turn, render, or asset import. Finish edits or renders
in other programs before saving or restoring. Checkpoints do not save changes
made by terminal agents automatically; save one before handing off to a terminal.
Keep a separate backup if you need protection against losing the project folder.

Frameyard uses your installed Codex executable, account, and normal layered Codex
configuration for the project folder. Permissions, plugins, MCP servers, hooks,
browser tools, web search, and image generation follow that configuration.
Frameyard does not enable or disable them separately. New and resumed chats use
your configured approval policy and developer instructions; this also replaces
the restrictions saved by older Frameyard versions. Editor tools and selection,
annotation, catalog, and timing guidance are added as turn context.

With full access and `approval_policy = "never"`, Frameyard does not introduce
command/file approval prompts. If your Codex configuration requires approvals,
Assistant shows **Allow once** and **Decline**. **Stop** interrupts a turn. After
updating Frameyard, restart it to apply the change to the next turn of an existing
chat. Your normal Codex configuration files are not rewritten.

## Effects

**Effects** contains Pixelate Region. Select or drag it into a scene, then choose
the area and cell size. Placement uses the marked range or up to three seconds
at the playhead. The effect stays editable in JSX and uses normal Undo.

**Use with agent** attaches its ID and settings without sending a message.
Combine it with **Mark area** and **Time range**, then describe placement or
revisions. The agent uses `editor_effects`, `editor_add_preset` and
`editor_update_preset`. The separate Highlight tool enlarges a live region
through `editor_add_highlight` and `editor_update`. See [Effects](reference/effects.md)
for the controls and examples.

## Animations and launch videos

Choose **Animations → New animation**, select HyperFrames or Manim, and describe the animation. The agent keeps HTML/GSAP or Python source in the project and registers it in `diffusion.animations`. Installed Hyfrme work appears here too. Preview first, then **Revise in chat**, export the animation, or ask for placement in a launch video.

Select an animation to play or scrub its preview. **Render preview** or **Render again** refreshes the retained source. **Cancel** stops rendering, export or conversion without replacing the previous result. **Add editable layers** converts supported objects and motion into native groups, text, paths and keyframes at the playhead. Unsupported features are reported before insertion; original source remains available. **Add rendered clip** fits the rendered media inside the active scene as one clip. Placement can be undone in one step. Preview and export work without an active scene.

**Motion** contains six native starting compositions. Select any child layer to edit its appearance or motion in **Properties**. Depth, tilt, scene camera, vector paths, glass and finishing effects are ordinary source properties and accept keyframes. See the [motion workspace reference](reference/jsx/motion-workspace.md) for controls and conversion limits.

Refreshing the list keeps the preview position when its rendered file is unchanged.

**Export animation** opens a save dialog. Opaque clips use MP4; transparent overlays use ProRes 4444 MOV with alpha for Resolve. **Show export** reveals the saved file. The editor retains source and preview separately so further revisions remain possible. Use the main scene export to deliver an assembled launch video.

Both renderers support transparent PNG sequences with a checkerboard preview. Sequence metadata preserves the rendered frame rate; `frameRate` in the registration can match the destination video. Older sequences without metadata remain 30 fps. Keep the numbered frames and `.sequence.json` together. Failed renders preserve the last output, successful replacements keep a backup, and damaged generated frames can be repaired with **Render again**.

## Templates and generated assets

Open a catalog item and choose **Add to chat**, or a website video and choose
**Remix with agent**. Your draft remains intact, and the item
appears as a removable reference above the composer. Attach several references
and describe how to use them. Sending includes their exact provider, item name,
source file paths, variables, dimensions/duration where provided, preview URLs,
and other published manifest metadata. The references stay in native Codex
history after sending; unsent references are saved locally with the chat draft.

**Back to catalog** restores your scroll position and keyboard focus. Escape
also returns from an item when focus is outside the search field. Searching or
changing the type filter returns to the matching results. Preview details show
dimensions and duration when published, with the chat action kept at the bottom.
**Full screen** keeps playback controls available. Leaving the catalog stops its
preview playback and releases hidden players.

Browsing or attaching an item does not install source, render video, or edit the
project. When you request an edit, the agent can retrieve source with the matching
catalog tool, customize it, render, and insert the result. **Website videos**
contains the eight promoted portrait videos from hyperframes.dev. The agent
receives their declared variables and the exact editable ZIP package, then
works on the downloaded HTML/assets. Their editing contract, original baseline,
source revision, and license are retained. **Starter examples** contains the
nine older complete compositions. Catalog scenes are reusable blocks, and
effects are components that need composition wiring.

Cards use published thumbnails, with isolated live previews when a thumbnail is
missing. Only visible cards load live previews; grid previews pause on a sample
frame, while **Play preview** starts the selected animation. Entries without
available media show an explicit placeholder. Website videos use the same versioned posters, previews, and editable packages
as hyperframes.dev. All eight have image/video previews. Eight of nine starter
examples have working image/video previews as of September 6, 2026. VS Code Theme
Visualizer and three catalog items currently return errors from upstream preview
URLs.

Hyfrme has its own published registry and catalog cache. Its 291 entries as of
September 6, 2026 include motion components, UI primitives, shaders, and icons.
The installed Hyfrme CLI copies their runtime, fonts, and licenses into the
project; the Hyfrme development repository is not required. Agents can browse
and install using `dapi tool hyfrme_catalog --args '{"action":"list"}'`.

Installations get unique folders under the project's `animations/`. Renderable
items are registered under `package.json` → `diffusion.animations`. Render again
after editing their source with `dapi animation render <id> --project <folder>`.
Failed renders keep the source and previous successful output. Some upstream
templates have defects or require external fonts/media; errors remain visible.
The catalog can be browsed from its saved cache offline, but new installations
and uncached previews need network access.

Search imports retain their source URLs and attribution alongside the project.
Original generated images arrive through Codex's built-in image-generation tool
and are imported automatically. They appear in Assets; ask the agent to place
one in the composition, or drag it onto the canvas. This is raster image
generation. Manim and HyperFrames provide source-driven animation; Diffusion
Studio's hosted generative video and speech services are not included.

Editing, rendering, local transcription, and direct catalog searches require no
Diffusion Studio credits. Codex chat, web search, and image generation use your
account's entitlements and remaining usage. Asset licenses belong to their sources.

## Panel size

Hover the inner edge of either side panel and drag to resize it, just like the
timeline divider. All right workspace tabs share one remembered width. The
timeline resizes with it. The right workspace uses the full window height, and
the audio mixer is available under **Audio**. Focus a
divider with Tab to resize with arrow keys; Shift takes larger steps.

Switching tabs keeps your chat draft, conversation, and catalog references.
The **Export scene** button stays available beside the tabs.

## Playback volume

Click the speaker beside Play and Loop for a 0–100% playback slider and mute.
The setting is remembered, and unmute restores the chosen level. This controls
listening volume only. Use the clip and Master faders in **Audio** to
change the audio mix in the exported video. Faders work before playback starts;
use arrow keys to adjust them or double-click to reset to 0 dB.

## Canvas view

Click **Fit** above the canvas, or press **Z** with the canvas focused, to fit the
complete scene in the available preview space. This changes only the view.

## Timeline view

Modifier-wheel zoom anchors to the playhead. If the playhead is offscreen, zoom
brings it into view. With the timeline focused, **Shift+Z** fits the complete
scene duration to the timeline width, independently of the playback workarea.
Neither action moves the playhead or changes clip timing.

## Scene selection

Click selects the top visible item. **Alt-click** repeatedly at an overlap to
cycle through the items there, including full-scene effects and nested group
contents. Double-click a group to enter it. Alt-drag on a resize handle keeps its
existing center-resize behavior.

Hidden, locked, and out-of-time items do not intercept canvas clicks. Select those
items in the timeline or layer list; unlock or reveal them before canvas editing.
