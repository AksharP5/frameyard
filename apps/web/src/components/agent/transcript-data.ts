import { z } from "zod";
import type { Transcript } from "@diffusionstudio/assets";

const wordSchema = z.object({
  text: z.string(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
}).refine((word) => word.end >= word.start, "Word ends before it starts");

const transcriptSchema = z.array(z.object({ text: z.string(), words: z.array(wordSchema) }));

export function parseTranscript(value: unknown): Transcript {
  const transcript = transcriptSchema.parse(value);
  let previous = 0;
  for (const segment of transcript) {
    for (const word of segment.words) {
      if (word.start < previous) throw new Error("Transcript word times are out of order.");
      previous = word.start;
    }
  }
  return transcript;
}

export function transcriptSentences(transcript: Transcript) {
  const words = transcript.flatMap((segment) => segment.words);
  const sentences: { first: number; last: number }[] = [];
  let first = 0;
  words.forEach((word, index) => {
    const next = words[index + 1];
    if (!next || /[.!?]["'”’)]*$/.test(word.text) || next.start - word.end > 1.5) {
      sentences.push({ first, last: index });
      first = index + 1;
    }
  });
  return { words, sentences };
}

/** A correction changes spelling only; the recording's word boundaries stay intact. */
export function correctTranscriptWord(transcript: Transcript, index: number, text: string): Transcript {
  const corrected = text.trim();
  if (!corrected) throw new Error("Enter the corrected word.");
  let offset = 0;
  let found = false;
  const result = transcript.map((segment) => {
    const words = segment.words.map((word) => {
      if (offset++ !== index) return word;
      found = true;
      return { ...word, text: corrected };
    });
    return { text: words.map((word) => word.text).join(" "), words };
  });
  if (!found) throw new Error("Select a word to correct.");
  return result;
}
