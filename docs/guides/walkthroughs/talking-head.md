# Example: long-form talking head

A single speaker to camera — an explainer, a podcast solo, a course lesson. The recording is long and raw: restarts, flubbed lines, and dead air between thoughts. The edit cuts it down to the clean story, back-to-back, never mid-word. The transcript drives the A-roll; the waveform separates silence from performance.

## 1. Brief

Write the brief first. It records the source files, the target duration (or "keep everything good"), and any editorial instruction. Absent a target length or explicit direction, **make no editorial cuts**: keep every good part, drop only silences and double takes, and keep the story chronological.

## 2. Analysis

The transcript is the spine, so transcribe everything with speech.

- **Transcribe every video and any external audio.** `media_transcribe` writes word-level start/end times to a JSON file — the times you cut on. Run it on each camera take and on any separate recording (a lav or interface track you will sync to).
- **Render the waveform to read the gaps.** `media_waveform` marks quiet spans in red and returns their times. A transcript gap may hold a laugh, breath, or room tone. Listen before removing it.
- **Compare repeated takes.** The transcript shows repeated lines. Listen for the clearest delivery, then use `media_grab` near each candidate's first word to check its framing and sharpness.

## 3. Lay out the A-roll

Choose the takes you want and put them in chronological order.

```tsx
import { For } from "solid-js";

const raw = "/Recordings/take.mp4";

// Kept stretches, in order — source range only.
const takes = [
  { src: raw, sourceIn: 48.2, sourceOut: 53.9 },  // opener — third take, sourceIn on the first word
  { src: raw, sourceIn: 61.7, sourceOut: 69.4 },  // next sentence — sourceIn opens ~0.4 s early for a breath
  { src: raw, sourceIn: 74.0, sourceOut: 78.1 },  // mid-sentence pickup — flubbed clause dropped
  { src: raw, sourceIn: 95.2, sourceOut: 102.8 }, // closer — trailing air left in sourceOut
];

// Chain them back-to-back: each start is the sum of the durations before it.
let cursor = 0;
const aRoll = takes.map((t) => {
  const start = cursor;
  cursor += t.sourceOut - t.sourceIn;
  return { ...t, start };
});

export default function Project() {
  return (
    <stage camera={[0.25, 0, 0, 0.25, 235, 70]}>
      <scene name="Talking head" width={1080} height={1920} fill="black" active>
        <sequence name="A-roll">
          <For each={aRoll}>
            {(clip) => (
              <video src={clip.src} width={1080} height={1920}
                start={clip.start} sourceIn={clip.sourceIn} sourceOut={clip.sourceOut} />
            )}
          </For>
        </sequence>
      </scene>
    </stage>
  );
}
```

The silence you *keep* between sentences lives inside the clips, not in a timeline gap — a gap in a sequence freezes or blanks the frame. Carry a pause by extending a clip's `sourceOut` (or opening the next `sourceIn`) into the real silence, and keep the timeline gapless.

Save the file — the app recompiles and re-renders it — and get the spine right before layering anything on top.

## 4. Cut points

- **At the start,** set `sourceIn` near the first useful line. Keep a lead-in if the delivery needs it.
- **Between sentences,** leave enough of the recorded pause for the thought to breathe. Adjust each clip's `sourceOut` or the next `sourceIn`.
- **Inside a sentence,** check both words and picture across the join. Avoid cutting through a word.
- **At the end,** keep the last line's natural tail so the picture and sound do not stop abruptly.

## 5. Verification

Run `check` on the scene first: on a long timeline of many clips, a `sourceOut`/`start` that don't meet leaves a gap no sampled frame would land on, and the check names those spans outright.

Then the cut points, which matter most. Capture the **first frame of every clip** with `capture` at each clip's `start`, and check the cut didn't land on a bad frame — motion blur is the usual tell; nudge `sourceIn` a few frames to a settled one. Reconcile against the brief, and re-check neighbouring cuts after any structural change.

## 6. Visual hook (optional)

A visual hook can help a viewer understand the topic at a glance. Use it only
when the footage needs one.

- **Copy.** Keep the message short enough to read at delivery size.
- **Placement.** Keep it clear of the speaker's face and important action.
- **Duration.** Leave it on screen long enough to read.

One line of copy is a job for the native `<text>` tag:

```tsx
<text
  x={80} y={1240} width={920} height={260}
  start={0} end={3}
  fontFamily="Inter" fontSize={84} fontWeight={500} color="#fff"
  textAlign="left" textBaseline="top"
>
  The one editing trick
</text>
```

## 7. Captions (optional)

Add captions after the cut and overlay are in place, so they transcribe the final
audio at its final placement. Use the `whisper` preset aligned to the bottom,
and start it where the hook ends. Set both `start` and `sourceIn` to that time
so the transcript stays aligned (see [captions](../../reference/jsx/captions.md)).
Keep captions off faces and other important details.

```tsx
{/* Hook holds until 00:03; captions begin there. */}
<captions preset="whisper" verticalAlign="bottom" start={3} sourceIn={3} />
```
