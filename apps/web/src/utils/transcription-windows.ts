import type { Transcript } from "@diffusionstudio/assets";

/** One-minute capture windows include two seconds of context at each edge. */
export function* transcriptionWindows(duration: number, frameRate: number) {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(frameRate) || frameRate <= 0) {
    throw new Error("The scene must have a finite duration before transcription");
  }
  const frames = Math.ceil(duration * frameRate);
  const length = Math.max(1, Math.round(60 * frameRate));
  const overlap = Math.ceil(2 * frameRate);
  for (let start = 0; start < frames; start += length) {
    const end = Math.min(frames, start + length);
    yield {
      start: start / frameRate, end: end / frameRate,
      from: Math.max(0, start - overlap) / frameRate,
      to: Math.min(frames, end + overlap) / frameRate,
    };
  }
}

type Window = ReturnType<typeof transcriptionWindows> extends Generator<infer T> ? T : never;

/** Keep overlap context until the next window can identify the same spoken word. */
export function mergeTranscriptWindow(transcript: Transcript, segments: Transcript, window: Window): Transcript {
  let previousStart = 0;
  const shifted = segments.map((segment) => ({
    text: segment.text,
    words: segment.words.map((word) => {
      if (!Number.isFinite(word.start) || !Number.isFinite(word.end)
        || word.start < 0 || word.end < word.start || word.start < previousStart) {
        throw new Error("Transcription returned invalid or unordered word timestamps.");
      }
      previousStart = word.start;
      return { text: word.text, start: word.start + window.from, end: word.end + window.from };
    }),
  }));
  const currentWords = shifted.flatMap((segment) => segment.words);
  const currentEnd = currentWords.findIndex((word) => word.start >= window.to);
  const count = currentEnd < 0 ? currentWords.length : currentEnd;
  const current = sliceTranscript(shifted, 0, count);
  if (window.start === 0) return current;

  const previousWords = transcript.flatMap((segment) => segment.words);
  const words = currentWords.slice(0, count);
  let match: { previous: number; current: number; distance: number } | undefined;
  for (let i = previousWords.length - 1; i >= 0; i--) {
    const previous = previousWords[i];
    if (previous.start < window.from) break;
    const text = boundaryWord(previous.text);
    if (!text) continue;
    for (let j = 0; j < words.length; j++) {
      const word = words[j];
      if (word.start > previous.end) break;
      if (boundaryWord(word.text) !== text) continue;
      const overlap = Math.min(word.end, previous.end) - Math.max(word.start, previous.start);
      if (overlap <= Math.max(word.end - word.start, previous.end - previous.start) / 2) continue;
      // Keep the previous copy only when the next word still follows it in time.
      if (words[j + 1] && words[j + 1].start < previous.start) continue;
      const distance = Math.abs((previous.start + previous.end + word.start + word.end) / 4 - window.start);
      if (!match || distance < match.distance) match = { previous: i, current: j, distance };
    }
  }
  if (match) {
    return [...sliceTranscript(transcript, 0, match.previous + 1), ...sliceTranscript(current, match.current + 1)];
  }

  // Without a shared word, one cut on start times guarantees an ordered join.
  const previousEnd = previousWords.findIndex((word) => word.start >= window.start);
  const currentStart = words.findIndex((word) => word.start >= window.start);
  return [
    ...sliceTranscript(transcript, 0, previousEnd < 0 ? previousWords.length : previousEnd),
    ...sliceTranscript(current, currentStart < 0 ? words.length : currentStart),
  ];
}

function boundaryWord(text: string): string {
  return text.toLowerCase().replace(/^[\p{P}\p{Z}]+|[\p{P}\p{Z}]+$/gu, "");
}

function sliceTranscript(transcript: Transcript, from: number, to = Infinity): Transcript {
  let offset = 0;
  return transcript.flatMap((segment) => {
    const words = segment.words.slice(Math.max(0, from - offset), Math.max(0, to - offset));
    offset += segment.words.length;
    return words.length ? [{ text: words.map((word) => word.text).join(" "), words }] : [];
  });
}
