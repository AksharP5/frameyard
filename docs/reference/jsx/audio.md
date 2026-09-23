# `<audio>`

An audio clip: no picture, carries volume. When timing is omitted, the node fits its natural duration (see [timing.md](./timing.md)).

It draws nothing inside a scene, but on the canvas it is still something to point at: the editor shows its waveform in a box, and `x`/`y`/`width`/`height` are where that box is. Leave them off inside a scene, where they mean nothing.

```tsx
<audio src="music/bed.mp3" start={2.2} sourceOut={16} volume={-6} />
```

## Props

| Prop | Type | Default | Meaning |
| ---- | ---- | ------- | ------- |
| `src` | `string \| AssetRef` | **required** | See [media.md](./media.md). |
| `id`, `name` | `string` | see [elements.md](./elements.md#common-props) | Address and label. |
| `x`, `y` | `number` | `0` | Where the waveform box sits on the canvas. No meaning inside a scene. |
| `width`, `height` | `number` | `500`, `150` | Size of that box. |
| `start`, `end`, `sourceIn`, `sourceOut` | `Time` | see [timing.md](./timing.md) | Temporal placement. |
| `playbackRate` | `number` | `1` | Speed multiplier for the clip's local time. |
| `volume` | `number` | `0` | Decibels: `0` = unity, negative attenuates (`-6` ≈ half as loud), `-Infinity` = silence. Not linear. |
| `muted` | `boolean` | `false` | Excludes the node's audio from the mix; independent of `volume`. |
| `audioStream` | `number` | `0` | Zero-based ordinal among the source file's audio streams. Preserved in preview and export. |
| `audioProcessing` | `AudioProcessingSettings` | none | Pan, EQ, compressor, and sample-peak limiter, described below. |
| `syncTo` | `string` | none | `id` of another element carrying audio; derives `start` by audio alignment (see [audio-sync.md](./audio-sync.md)). Mutually exclusive with `start`. |

An audio clip has no picture, so it takes no transform beyond its canvas box and no paints. Its children are [`<keyframeTrack>`](./keyframes.md) (a `volume` track) and [`<animation>`](./animations.md), of which only `"gain"` is audible:

```tsx
<audio src="music/bed.mp3" start={0} end={12} volume={-16}>
  <animation type="gain" duration={1} />
  <animation type="gain" phase="out" duration={2} />
</audio>
```

## Processing

`audioProcessing` also applies to video, group, and scene audio buses. Processing
runs in this order: low/mid/high EQ, compressor, stereo pan, volume, then limiter.

```tsx
<audio src="interview.mov" audioStream={1} link="interview" audioProcessing={{
  pan: -0.2,
  eq: [-2, 1, 0],
  compressor: { threshold: -18, ratio: 4, attack: 0.01, release: 0.1 },
  limiter: -1,
}} />
```

Pan ranges from -1 to 1. EQ gains range from -24 to 24 dB, at 120 Hz, 1 kHz, and
6 kHz. Compressor threshold is dBFS, ratio is 1–20, and attack/release are seconds.
Omit `compressor` to bypass it. Limiter is a ceiling from -24 to 0 dBFS; omit it to
bypass. It limits sample peaks, not intersample true peaks. Both dynamics stages
use the same zero-lookahead processing in preview and export.

The scene inspector's loudness normalization measures the rendered mix and
adjusts master volume toward the chosen LUFS target while reserving -1 dBTP
headroom. It preserves dynamics and reports when peaks prevent reaching the
target. It is not a continuous loudness processor.
