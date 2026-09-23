import { createRenderEffect, createSignal, onCleanup } from "solid-js";
import { loadChatDraft, saveChatDraftField } from "@/lib/db";
import type { CodexImage } from "@desktop/codex-image-contracts";
import type { CodexSkill } from "@desktop/codex-capabilities";
import type { Animation } from "@desktop/animation-contracts";
import type { TimeRange } from "@desktop/annotation-contracts";
import type { PresetDefinition, PresetSettings } from "@diffusionstudio/jsx";
import type { CatalogReference } from "./hyperframes-catalog";
import type { FullTranscriptAttachment } from "./full-transcript";
import type { VideoContextAttachment } from "./video-context";
import type { AreaAttachment } from "./area-annotation";

export const catalogTabs = ["Motion", "HyperFrames", "Templates", "Hyfrme"] as const;
export const toolTabs = ["Editor", "Effects", "Transcript", "Audio", "Checkpoints", "Assets"] as const;
export const agentTabs = ["Chat", "Animations", ...catalogTabs, ...toolTabs] as const;
export type ChatDraft = {
  projectDir: string;
  harness: "codex" | "claude";
  tab: typeof agentTabs[number];
  draft: string;
  images: CodexImage[];
  skills: CodexSkill[];
  references: CatalogReference[];
  animationReferences: Animation[];
  effectReference: { definition: PresetDefinition; settings?: PresetSettings } | undefined;
  transcript: FullTranscriptAttachment | undefined;
  videoContext: VideoContextAttachment | undefined;
  area: AreaAttachment | undefined;
  timeRange: TimeRange | undefined;
  modelOverride: string | undefined;
  effortOverride: string | undefined;
};

const pendingWrites = new Map<string, Promise<void>>();
const pendingSubmissions = new Map<string, Promise<void>>();

/** Dashboard navigation and failed sends use the same persisted draft as the workspace. */
export async function prepareChatDraft(project: { id: string; dir: string }, harness: ChatDraft["harness"], unsent?: { text: string; model: string; skills?: CodexSkill[] }) {
  const key = `project:${project.id}`;
  await Promise.all([pendingWrites.get(key), pendingSubmissions.get(key)]);
  const writing = (async () => {
    const saved = await loadChatDraft(key, project.dir);
    await saveChatDraftField(key, "harness", harness);
    await saveChatDraftField(key, "tab", "Chat");
    if (!unsent) return;
    await saveChatDraftField(key, "draft", [saved.draft?.trimEnd(), unsent.text].filter(Boolean).join("\n\n"));
    await saveChatDraftField(key, "modelOverride", unsent.model);
    if (unsent.skills?.length) {
      const skills = new Map([...(saved.skills ?? []), ...unsent.skills].map((skill) => [skill.path, skill]));
      await saveChatDraftField(key, "skills", [...skills.values()]);
    }
  })();
  pendingWrites.set(key, writing);
  try { await writing; }
  finally { if (pendingWrites.get(key) === writing) pendingWrites.delete(key); }
}

/** Each field has its own row so typing never rewrites image attachments. */
export function createChatDraft(project: { id: string; dir: string }, fail: (cause: unknown) => void) {
  const storageKey = `project:${project.id}`;
  const previous = [pendingWrites.get(storageKey), pendingSubmissions.get(storageKey)];
  const restore = Promise.all(previous.map((work) => work?.catch(fail))).then(() => loadChatDraft(storageKey, project.dir));
  const loaded: Promise<Partial<ChatDraft>> = restore.catch((cause) => {
    fail(cause);
    return {};
  });
  const restores: Promise<void>[] = [];
  const saves: (() => void)[] = [];
  const writes = new Set<Promise<void>>();
  let disposed = false;
  onCleanup(() => { disposed = true; });

  function field<Key extends keyof ChatDraft>(key: Key, initial: ChatDraft[Key]) {
    const signal = createSignal<ChatDraft[Key]>(initial);
    const [value, setValue] = signal;
    let previous = initial;
    let edited = false;
    let restoring = false;
    const save = () => {
      const current = value();
      if (current === previous) return;
      previous = current;
      if (restoring) return;
      edited = true;
      const writing = loaded.then(() => saveChatDraftField(storageKey, key, current));
      pendingWrites.set(storageKey, writing);
      const finished = () => { if (pendingWrites.get(storageKey) === writing) pendingWrites.delete(storageKey); };
      const reported = writing.then(finished, (cause) => { finished(); fail(cause); });
      writes.add(reported);
      void reported.then(() => writes.delete(reported));
    };
    saves.push(save);
    createRenderEffect(save);
    restores.push(loaded.then((draft) => {
      if (disposed) return;
      const saved = draft[key];
      if (!edited && saved !== undefined) {
        restoring = true;
        setValue(() => saved);
        restoring = false;
      }
    }).catch(fail));
    return signal;
  }

  // An accepted send may finish after its panel closes. Persist its changes
  // before a reopened panel restores, while preserving anything typed there.
  function trackSubmission(submission: Promise<void>): void {
    const pending = submission.finally(async () => {
      for (const save of saves) save();
      await Promise.all(writes);
    }).catch(fail);
    pendingSubmissions.set(storageKey, pending);
    void pending.then(() => { if (pendingSubmissions.get(storageKey) === pending) pendingSubmissions.delete(storageKey); });
  }

  return { field, ready: () => Promise.all(restores), trackSubmission };
}
