# Example: podcast clipping

A long conversation cut down to one vertical short. Find a moment that makes
sense without the rest of the episode before downloading or editing the video.
Frameyard can transcribe and inspect the audio offline.

## 1. Brief

Record the source, number of clips, target duration and frame size, and any
speaker or topic to favor. A short clip needs its own opening and conclusion;
check that a viewer can understand it without the rest of the conversation.

## 2. Audio-only pass

If the source is online, download its audio with
[yt-dlp](https://github.com/yt-dlp/yt-dlp). Replace the URL with one you have
permission to use:

```bash
yt-dlp -x --audio-format m4a -o podcast.m4a 'https://example.com/podcast'
```

## 3. Transcribe and scan

Run local transcription after [`setup:local`](../../linux.md):

```sh
dapi media transcribe "$PWD/podcast.m4a" --output "$PWD/transcript.json"
dapi media waveform "$PWD/podcast.m4a"
```

The transcript contains segment text and word-level times in source seconds.
Search the text for a topic or line, then read the surrounding segments. For a
long recording, use chapter markers or 15 to 30 minute sections to keep the
review manageable. The waveform shows pauses and helps locate clean boundaries.

## 4. Choose a moment

Shortlist moments that open with a clear line and end after a complete thought.
Listen to each candidate in context. Transcript text alone cannot tell you
whether a speaker hesitates, talks over someone, or lands the final line. Write
down the source start and end times for the best candidate.

## 5. Lock the exact cut points

Tighten both ends against the real audio:

- Search `transcript.json` for the hook line. Put the in-point near its first word and the out-point after the last word of the closing thought.
- `media_waveform` with `start`/`end` around the cut shows the breaths around those words, so you can open the in-point a beat early and let the out-point land on the silence after the line instead of clipping its tail.

## 6. Download the segment and lay it out

Create a Frameyard project folder and download the video into its `assets/`
directory. Include a few seconds on either side of the chosen range so you can
adjust the trim. `--download-sections` can fetch just that window:

```bash
mkdir -p ~/Videos/podcast-short/assets/a-roll
cd ~/Videos/podcast-short
yt-dlp -f "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b" --merge-output-format mp4 \
  --download-sections "*41:08-41:48" -o assets/a-roll/clip-raw.mp4 'https://example.com/podcast'
```

Probe the downloaded dimensions with `dapi media probe`. A section download can
start before the requested point at a source keyframe, so play the downloaded
clip and set its `sourceIn` and `sourceOut` using the downloaded file's own time.

Give the node the **source's own aspect ratio**, scaled to the scene height, rather than the scene's box: the node is then wider than the scene, and the scene crops it. That geometry is what makes the framing in the next step possible.

```tsx
const raw = "a-roll/clip-raw.mp4"; // library path: the download landed under assets/

// Locked range, expressed in the padded download's own time.
const IN = 6.4;   // first word of the hook
const OUT = 36.1; // after the final phrase

const SCENE_W = 1080;
const NODE_H = 1920;
const NODE_W = NODE_H * (1920 / 1080); // replace with the probed source dimensions

export default function Project() {
  return (
    <stage camera={[0.25, 0, 0, 0.25, 235, 70]}>
      <scene name="Podcast clip" width={SCENE_W} height={1920} fill="black" active>
        <sequence name="A-roll">
          <video src={raw} width={NODE_W} height={NODE_H} x={(SCENE_W - NODE_W) / 2}
            start={0} sourceIn={IN} sourceOut={OUT} />
        </sequence>
      </scene>
    </stage>
  );
}
```

Save the composition as `index.tsx`, run `dapi open .`, and check frames near
the in-point and out-point with `dapi capture` before adding captions.

## 7. Frame the active speaker

If the speakers occupy different sides of the source frame, select the video
layer and keyframe its horizontal position when the active speaker changes.
Check each move at the actual output size. A wide crop can cut off hands or
captions that were visible in the source.

## 8. Captions

Add captions after verifying the trim and framing. This example places the
`classic` preset in the center:

```tsx
<captions preset="classic" verticalAlign="center" />
```

If the caption block lands on the speakers' faces, push it off with `offsetY` rather than changing the framing you just verified:

```tsx
<captions preset="classic" verticalAlign="center" offsetY={420} />
```

Capture a frame per caption line with `capture` and check readability at delivery size — a caption over a mouth is worse than no caption.
