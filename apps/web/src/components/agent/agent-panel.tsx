import { For, Show, createEffect, createMemo, createSignal, mapArray, onCleanup, onMount } from "solid-js";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import type { CodexCommands, CodexConversation, CodexEvent, CodexMessage, CodexSession } from "@desktop/codex-contracts";
import { useProject } from "@/context/project";
import { useSelection } from "@/engine/hooks/use-selection";
import { useAssetSelection } from "@/engine/hooks/use-asset-selection";
import { useLibrary } from "@/engine/library";
import { useProjectConfig } from "@/engine/project-config";
import { getAssetFile, Name, Source } from "@diffusionstudio/runtime";
import { getEditorContext } from "@/dapi/handlers/context";
import { editorSession } from "@/dapi/session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { ChatImages, readChatImages } from "./chat-images";
import { codexImagesSchema } from "@desktop/codex-image-contracts";
import { ChatPanel } from "@/agent-chat/chat-panel";
import { Composer } from "@/agent-chat/composer";
import { Transcript } from "@/agent-chat/transcript";
import type { Item } from "@diffusionstudio/agent-chat";
import { HyperframesCatalog, type CatalogReference } from "./hyperframes-catalog";
import { AssetSearch } from "./asset-search";
import { AnimationsPanel } from "./animations-panel";
import { MotionLibrary } from "./motion-library";
import { EffectsPanel } from "./effects-panel";
import { VideoContextButton } from "./video-context";
import { TranscriptPanel } from "./transcript-panel";
import { CheckpointPanel, saveProjectCheckpoint } from "./checkpoint-panel";
import { flushProjectEdits, getProjectSaveState } from "@/projects/edits";
import { AreaAnnotation, captureAnnotationFrame } from "./area-annotation";
import { TimeRangePicker, captureTimeRangeContext } from "./time-range";
import { Inspector } from "@/components/sidebar-right";
import { TabsContent } from "@/components/ui/tabs";
import { WorkspaceTabs } from "./workspace-tabs";
import { Soundboard } from "@/components/sidebar-right/soundboard";
import { usePromptInput } from "@/context/prompt-input";

import { CodexRequest } from "./codex-request";
import type { CodexPendingRequest } from "@desktop/codex-requests";
import { CodexCapabilitiesPicker } from "./codex-capabilities";
import { createCodexCapabilities } from "./use-codex-capabilities";
import { insertSkillMention, retainSkillMentions } from "@/agent-chat/skill-mentions";
import { catalogTabs, toolTabs, createChatDraft, type ChatDraft } from "./chat-draft";

type Approval = Extract<CodexEvent, { type: "approval" }>;

export function AgentPanel(props: { open: boolean; onNavigationReady?: (navigate: ((tab: ChatDraft["tab"]) => void) | undefined) => void }) {
  const project = useProject();
  const selection = useSelection();
  const selectedAsset = useAssetSelection();
  const library = useLibrary();
  const config = useProjectConfig();
  const [draftError, setDraftError] = createSignal("");
  const savedDraft = createChatDraft({ id: project.id(), dir: project.dir() }, (cause) => setDraftError(`Could not save or restore chat draft: ${cause instanceof Error ? cause.message : String(cause)}`));
  const [draftReady, setDraftReady] = createSignal(false);
  const [tab, setTab] = savedDraft.field("tab", "Editor");
  const [harness, setHarness] = savedDraft.field("harness", "codex");
  onMount(() => {
    props.onNavigationReady?.(setTab);
    onCleanup(() => props.onNavigationReady?.(undefined));
  });
  const { promptInputOpen, setPromptInputOpen } = usePromptInput();
  const [visited, setVisited] = createSignal<readonly string[]>(["Chat"]);
  createEffect(() => {
    const selected = tab();
    setVisited((current) => current.includes(selected) ? current : [...current, selected]);
  });
  const [conversation, setConversation] = createSignal<CodexConversation | null>(null);
  const [messages, setMessages] = createSignal<CodexMessage[]>([]);
  const [messageStart, setMessageStart] = createSignal(0);
  const [sendCount, setSendCount] = createSignal(0);
  const [draft, setDraft] = savedDraft.field("draft", "");
  const [images, setImages] = savedDraft.field("images", []);
  const [readingImages, setReadingImages] = createSignal(false);
  const [skills, setSkills] = savedDraft.field("skills", []);
  const capabilities = createCodexCapabilities(project.dir, () => harness() === "codex");
  const [references, setReferences] = savedDraft.field("references", []);
  const [animationReferences, setAnimationReferences] = savedDraft.field("animationReferences", []);
  const [effectReference, setEffectReference] = savedDraft.field("effectReference", undefined);
  const [transcript, setTranscript] = savedDraft.field("transcript", undefined);
  const [videoContext, setVideoContext] = savedDraft.field("videoContext", undefined);
  const [analyzing, setAnalyzing] = createSignal(false);
  const [transcribing, setTranscribing] = createSignal(false);
  const [checkpointing, setCheckpointing] = createSignal(false);
  const [checkpointRevision, setCheckpointRevision] = createSignal(0);
  const [undo, setUndo] = createSignal<CodexConversation["undo"]>();
  const [confirmUndo, setConfirmUndo] = createSignal(false);
  const [animationRevision, setAnimationRevision] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [submitting, setSubmitting] = createSignal(false);
  const [activeTurnId, setActiveTurnId] = createSignal<string>();
  const [capturing, setCapturing] = createSignal(false);
  const [area, setArea] = savedDraft.field("area", undefined);
  const [areaFrame, setAreaFrame] = createSignal<Awaited<ReturnType<typeof captureAnnotationFrame>>>();
  const [timeRange, setTimeRange] = savedDraft.field("timeRange", undefined);
  const [rangeScene, setRangeScene] = createSignal<Awaited<ReturnType<typeof captureTimeRangeContext>>>();
  const [loading, setLoading] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal("");
  const [connectionError, setConnectionError] = createSignal("");
  const [activity, setActivity] = createSignal("");
  const [account, setAccount] = createSignal("");
  const [codexStatus, setCodexStatus] = createSignal<CodexCommands["status"]["result"]>();
  const [modelOverride, setModelOverride] = savedDraft.field("modelOverride", undefined);
  const [effortOverride, setEffortOverride] = savedDraft.field("effortOverride", undefined);
  const model = () => modelOverride() ?? conversation()?.settings.model ?? codexStatus()?.defaults.model ?? "";
  const modelOption = createMemo(() => codexStatus()?.models.find((option) => option.model === model()));
  const effort = () => effortOverride() ?? conversation()?.settings.reasoningEffort ?? codexStatus()?.defaults.reasoningEffort ?? modelOption()?.defaultReasoningEffort ?? "";
  const [requests, setRequests] = createSignal<CodexPendingRequest[]>([]);
  const [approval, setApproval] = createSignal<Approval | null>(null);
  const [approving, setApproving] = createSignal(false);
  const [sessions, setSessions] = createSignal<CodexSession[]>([]);
  const [showSessions, setShowSessions] = createSignal(false);
  const [copiedSession, setCopiedSession] = createSignal("");
  const [handedOff, setHandedOff] = createSignal(false);
  const [sessionSearch, setSessionSearch] = createSignal("");
  const [cursor, setCursor] = createSignal<string | null>(null);
  let initialized = false;
  let disposed = false;
  let input: HTMLTextAreaElement | undefined;
  let imageInput: HTMLInputElement | undefined;
  let deltaTimer: ReturnType<typeof setTimeout> | undefined;
  let loadGeneration = 0;
  let eventRevision = 0;
  let eventThreadId: string | undefined;
  const pendingDeltas = new Map<string, string>();
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const waiting = () => approval() !== null || requests().some((request) => request.kind !== "input" || request.isBlocking);
  const hasContent = () => !!(draft().trim() || images().length || skills().length || area() || timeRange()
    || references().length || animationReferences().length || effectReference() || transcript() || videoContext());
  onCleanup(() => {
    disposed = true;
    loadGeneration++;
    clearTimeout(deltaTimer);
  });

  const flushDeltas = () => {
    clearTimeout(deltaTimer);
    deltaTimer = undefined;
    if (!pendingDeltas.size) return;
    setMessages((current) => {
      const next = current.map((message) => {
        const text = pendingDeltas.get(message.id);
        if (text === undefined) return message;
        pendingDeltas.delete(message.id);
        return { ...message, text: message.text + text };
      });
      for (const [id, text] of pendingDeltas) next.push({ id, role: "assistant", text });
      return next;
    });
    pendingDeltas.clear();
  };

  void savedDraft.ready().then(() => { if (!disposed) setDraftReady(true); });

  const updateRequests = (next: CodexPendingRequest[]) => setRequests((current) => {
    // Requests are immutable by ID. Keep their forms mounted across IPC snapshots.
    const existing = new Map(current.map((request) => [request.id, request]));
    return next.map((request) => existing.get(request.id) ?? request);
  });

  const useConversation = (next: CodexConversation | null, resetOptions = true) => {
    loadGeneration++;
    eventThreadId = next?.session.id;
    clearTimeout(deltaTimer);
    deltaTimer = undefined;
    pendingDeltas.clear();
    setConversation(next);
    setUndo(next?.undo);
    setConfirmUndo(false);
    if (resetOptions) { setModelOverride(undefined); setEffortOverride(undefined); }
    setMessages(next?.messages ?? []);
    setMessageStart(Math.max(0, (next?.messages.length ?? 0) - 60));
    setBusy(next?.activeTurn ?? false);
    setActiveTurnId(next?.activeTurnId);
    setApproval(next?.pendingApproval ?? null);
    updateRequests(next?.pendingRequests ?? []);
    setReady(true);
  };

  const load = async (threadId?: string) => {
    const generation = ++loadGeneration;
    const dir = project.dir();
    flushDeltas();
    eventThreadId = threadId ?? conversation()?.session.id;
    setReady(false);
    while (!disposed && generation === loadGeneration && project.dir() === dir) {
      const revision = eventRevision;
      const response = await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "load", input: { dir, threadId } }).catch((cause) => {
        if (!disposed && generation === loadGeneration && project.dir() === dir) throw cause;
      });
      if (!response || disposed || generation !== loadGeneration || project.dir() !== dir || response.method !== "load") return;
      // Snapshots have no delta cursor. Read again when events overlap instead of
      // guessing which streamed text the snapshot already contains.
      if (revision !== eventRevision) {
        let quietRevision: number;
        do {
          quietRevision = eventRevision;
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        } while (!disposed && generation === loadGeneration && quietRevision !== eventRevision);
        continue;
      }
      useConversation(response.result, threadId !== undefined);
      return;
    }
  };

  const retryConnection = async () => {
    if (loading() || disposed) return;
    const dir = project.dir();
    setLoading(true);
    setError("");
    setConnectionError("");
    const results = await Promise.allSettled([
      ready() ? Promise.resolve() : load(),
      codexStatus() && !codexStatus()?.requiresLogin ? Promise.resolve() : mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "status", input: { dir } }).then((response) => {
        if (response.method !== "status" || disposed || project.dir() !== dir) return;
        setCodexStatus(response.result);
        setAccount(response.result.requiresLogin ? "Run codex login in your terminal" : `Local Codex${response.result.account?.plan ? ` · ${response.result.account.plan}` : ""}`);
      }),
    ]);
    if (disposed || project.dir() !== dir) return;
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    if (errors.length) {
      const message = errors.join("\n");
      setConnectionError(message);
      setError(message);
    }
    setLoading(false);
  };

  createEffect(() => {
    if (!draftReady() || !props.open || tab() !== "Chat" || harness() !== "codex" || initialized) return;
    initialized = true;
    void retryConnection();
  });

  createEffect(() => {
    if (!promptInputOpen()) return;
    setTab("Chat");
    setPromptInputOpen(false);
  });

  onCleanup(mainBridge.handle(MAIN_CHANNELS.CODEX_EVENT, (event) => {
    if (event.dir !== project.dir()) return;
    if (eventThreadId && event.threadId !== eventThreadId) return;
    eventThreadId ??= event.threadId;
    if (event.type === "delta" || event.type === "turn" || event.type === "requests" || event.type === "approval") eventRevision++;
    if (conversation() && conversation()?.session.id !== event.threadId) return;
    if (event.type === "delta") {
      if (!ready() && event.turnId) { setBusy(true); setActiveTurnId(event.turnId); }
      pendingDeltas.set(event.itemId, (pendingDeltas.get(event.itemId) ?? "") + event.text);
      deltaTimer ??= setTimeout(flushDeltas, 50);
    }
    if (event.type === "activity") setActivity(event.text);
    if (event.type === "requests") updateRequests(event.requests);
    if (event.type === "approval") setApproval(event);
    if (event.type === "generated") {
      void library()?.load().catch(fail);
      setActivity("Generated image added to Assets");
    }
    if (event.type === "turn") {
      flushDeltas();
      setUndo(event.undo);
      setBusy(event.status === "started");
      setActiveTurnId(event.status === "started" ? event.turnId : undefined);
      if (event.status !== "started") {
        setAnimationRevision((revision) => revision + 1);
        setCheckpointRevision((revision) => revision + 1);
        setApproval(null);
        setRequests([]);
        setActivity(event.status === "interrupted" ? "Stopped" : "");
        if (event.error) setError(event.error);
      }
    }
  }));

  const addImages = async (files: File[]) => {
    if (disposed || submitting() || !files.length) return;
    if (readingImages()) { setError("Wait for the current images to finish loading."); return; }
    const dir = project.dir();
    setReadingImages(true);
    setError("");
    try {
      const next = await readChatImages(files);
      if (disposed || project.dir() !== dir) return;
      const combined = [...images(), ...next];
      codexImagesSchema.parse(combined);
      setImages(combined);
    } catch (cause) { if (!disposed && project.dir() === dir) fail(cause); }
    finally { if (!disposed) setReadingImages(false); }
  };
  const attachSelectedImage = async () => {
    const asset = selectedAsset.asset();
    const dir = project.dir();
    if (asset?.type !== "IMAGE") return;
    try {
      const file = await getAssetFile(asset);
      if (!disposed && project.dir() === dir) await addImages([new File([file], file.name, { type: file.type || asset.mimeType })]);
    } catch (cause) { if (!disposed) fail(cause); }
  };

  const send = async () => {
    const attachedImages = images();
    const selectedSkills = skills();
    const attachment = area();
    const timing = timeRange();
    const catalogReferences = references();
    const animations = animationReferences();
    const effect = effectReference();
    const video = videoContext();
    const fullTranscript = transcript() ?? video?.fullTranscript;
    const steering = busy();
    const expectedTurnId = steering ? activeTurnId() : undefined;
    const chosenModel = steering ? undefined : modelOverride();
    const chosenEffort = steering ? undefined : effortOverride();
    const originalDraft = draft();
    const message = originalDraft.trim();
    const note = attachment?.annotation.note ?? "";
    if (!hasContent() || waiting() || readingImages() || submitting() || (steering && !expectedTurnId) || loading() || capturing() || transcribing() || analyzing() || checkpointing() || !ready() || !draftReady()) return;
    if (attachment && timing && attachment.annotation.sceneId !== timing.sceneId) {
      setError("The area and time range refer to different scenes. Remove or reattach one before sending.");
      return;
    }
    const referenceText = catalogReferences.length ? `References: ${catalogReferences.map(({ catalog, item }) => `${catalog === "hyfrme" ? "Hyfrme" : "HyperFrames"} / ${item.title}`).join(", ")}` : "";
    const text = [message, attachedImages.length ? `Images: ${attachedImages.map((image) => image.name).join(", ")}` : "", selectedSkills.length ? `Skills: ${selectedSkills.map((skill) => `$${skill.name}`).join(", ")}` : "", effect ? `Effect: ${effect.definition.title}` : "", attachment ? `Marked area: ${attachment.annotation.sceneName} at ${attachment.annotation.time.toFixed(3)}s` : "", note && note !== message ? `Area note: ${note}` : "", timing ? `Time range: ${timing.start.toFixed(3)} to ${timing.end.toFixed(3)}s in ${timing.sceneName}` : "", referenceText, video ? `Video context: ${video.sceneName} (${video.frames.length} frames, ${video.duration.toFixed(2)}s)` : "", fullTranscript ? `Full transcript: ${fullTranscript.sceneName} (${fullTranscript.duration.toFixed(2)}s)` : "", animations.length ? `Animations: ${animations.map((item) => item.id).join(", ")}` : ""].filter(Boolean).join("\n\n");
    const dir = project.dir();
    const messageId = crypto.randomUUID();
    setSubmitting(true);
    if (!steering) setBusy(true);
    setError("");
    if (!steering) setActivity("Working…");
    try {
      const session = editorSession();
      if (!session || session.project.dir() !== dir) throw new Error("The project is no longer open");
      const current = await getEditorContext(editorSession);
      if (disposed || editorSession() !== session || project.dir() !== dir) throw new Error("The project changed before sending");
      const context = { ...current, projectSave: getProjectSaveState(session.world), ...(attachment ? { annotationSelection: attachment.snapshot.context } : {}), catalogReferences, animationReferences: animations, ...(effect ? { effectReference: { id: effect.definition.id, title: effect.definition.title, tool: "editor_add_preset", editTool: "editor_update_preset", description: effect.definition.description, controls: effect.definition.controls, labels: effect.definition.labels, settings: effect.settings ?? effect.definition.defaults, instruction: "Use this preset ID with the marked region and requested start/end. Keep the result editable." } } : {}), ...(fullTranscript ? { fullTranscript } : {}), ...(video ? { videoContext: video } : {}) };
      if (disposed || context.projectDir !== dir) return;
      if (handedOff()) await load();
      if (!conversation()) {
        const response = await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "new", input: { dir } });
        if (disposed) return;
        if (response.method === "new") useConversation(response.result);
      }
      if (!steering) setBusy(true);
      flushDeltas();
      setSendCount((count) => count + 1);
      setMessages((current) => [...current, { id: messageId, role: "user", text }]);
      const response = await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "send", input: { dir, text, context, images: attachedImages, expectedTurnId, skills: selectedSkills.map(({ name, path }) => ({ name, path })), annotation: attachment?.annotation, timeRange: timing, videoFrames: video?.frames.map(({ time, path }) => ({ sceneId: video.sceneId, time, path })), model: chosenModel, reasoningEffort: chosenEffort } });
      if (response.method === "send" && busy()) setActiveTurnId(response.result.turnId);
      setConversation((current) => current && { ...current, settings: { model: chosenModel ?? current.settings.model, reasoningEffort: chosenEffort ?? current.settings.reasoningEffort } });
      setDraft((current) => current === originalDraft ? "" : current);
      setModelOverride(undefined);
      setEffortOverride(undefined);
      setImages((current) => current.filter((image) => !attachedImages.includes(image)));
      setSkills((current) => current.filter((skill) => !selectedSkills.includes(skill)));
      setTranscript((current) => current === fullTranscript ? undefined : current);
      setVideoContext((current) => current === video ? undefined : current);
      setArea((current) => current === attachment ? undefined : current);
      setTimeRange((current) => current === timing ? undefined : current);
      setReferences((current) => current.filter((reference) => !catalogReferences.includes(reference)));
      setAnimationReferences((current) => current.filter((item) => !animations.includes(item)));
      if (effect) setEffectReference((current) => current === effect ? undefined : current);
      setHandedOff(false);
      setCopiedSession("");
    } catch (cause) {
      setMessages((current) => current.filter((item) => item.id !== messageId));
      fail(cause);
      if (!steering) { setBusy(false); setActiveTurnId(undefined); setActivity(""); }
      setModelOverride(chosenModel);
      setEffortOverride(chosenEffort);
    } finally {
      setSubmitting(false);
    }
  };

  const undoLastTurn = async () => {
    const target = undo();
    const session = editorSession();
    const dir = project.dir();
    if (!target || !session || busy() || submitting() || loading() || checkpointing()) return;
    setCheckpointing(true);
    setError("");
    try {
      await flushProjectEdits(session.world, { allowUnloaded: true });
      await library()?.settle();
      await config()?.settle();
      if (disposed || editorSession() !== session || project.dir() !== dir) throw new Error("The project changed before undoing the turn");
      await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "undo", input: { dir, threadId: target.threadId, turnId: target.turnId } });
      if (disposed || project.dir() !== dir) return;
      setUndo(undefined);
      setCheckpointRevision((revision) => revision + 1);
      setAnimationRevision((revision) => revision + 1);
      setActivity("Last turn undone. Previous files saved in Checkpoints.");
    } catch (cause) { if (!disposed) fail(cause); }
    finally { setCheckpointing(false); setConfirmUndo(false); }
  };

  const markArea = async () => {
    if (capturing() || submitting() || analyzing()) return;
    setCapturing(true);
    setError("");
    try {
      const snapshot = await captureAnnotationFrame();
      if (!disposed) setAreaFrame(snapshot);
    } catch (cause) { fail(cause); }
    finally { setCapturing(false); }
  };

  const markTime = async () => {
    if (capturing() || submitting() || analyzing()) return;
    setCapturing(true);
    setError("");
    try {
      const snapshot = await captureTimeRangeContext();
      if (!disposed) setRangeScene(snapshot);
    } catch (cause) { fail(cause); }
    finally { setCapturing(false); }
  };

  const listSessions = async (more = false) => {
    setLoading(true);
    setError("");
    try {
      const response = await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "sessions", input: { dir: project.dir(), search: sessionSearch() || undefined, cursor: more ? cursor() ?? undefined : undefined } });
      if (response.method !== "sessions") return;
      setSessions((current) => more ? [...current, ...response.result.sessions] : response.result.sessions);
      setCursor(response.result.cursor);
      setShowSessions(true);
    } catch (cause) { fail(cause); }
    finally { setLoading(false); }
  };

  const resume = async (id: string) => {
    setLoading(true); setError("");
    try { await load(id); setShowSessions(false); }
    catch (cause) { fail(cause); }
    finally { setLoading(false); }
  };

  const ask = (prompt: string) => { setHarness("codex"); setTab("Chat"); setDraft((current) => current.trim() ? `${current.trimEnd()}\n\n${prompt}` : prompt); queueMicrotask(() => input?.focus()); };
  const copyResume = async () => {
    const current = conversation();
    if (!current || busy() || loading()) return;
    setLoading(true);
    setError("");
    try {
      const response = await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "release", input: { dir: project.dir() } });
      if (response.method !== "release") return;
      setHandedOff(true);
      await navigator.clipboard.writeText(response.result.command);
      setCopiedSession(current.session.id);
    } catch (cause) { fail(cause); }
    finally { setLoading(false); }
  };
  const reference = (next: CatalogReference) => {
    setHarness("codex");
    setReferences((current) => [...current.filter(({ catalog, item }) => catalog !== next.catalog || item.name !== next.item.name || item.type !== next.item.type), next]);
    setTab("Chat");
    queueMicrotask(() => input?.focus());
  };
  const decide = async (decision: "accept" | "decline") => {
    const requestId = approval()?.requestId;
    if (!requestId || approving()) return;
    setApproving(true);
    setError("");
    try {
      await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "approve", input: { requestId, decision } });
      setApproval((current) => current?.requestId === requestId ? null : current);
    } catch (cause) { fail(cause); }
    finally { setApproving(false); }
  };

  const visibleMessages = createMemo<CodexMessage[]>((previous) => {
    if (!props.open || tab() !== "Chat" || harness() !== "codex") return previous ?? [];
    return messages().slice(messageStart());
  });
  const visibleItems = mapArray(visibleMessages, (message): Item => ({ id: message.id, kind: message.role, text: message.text }));

  return <WorkspaceTabs tab={tab()} onChange={setTab} open={props.open}>
    <TabsContent value="Chat" forceMount class="min-h-0 flex flex-col overflow-hidden" classList={{ hidden: tab() !== "Chat" }}>
      <div class="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2">
        <div class="flex min-w-0 flex-1 items-center gap-1" title={[account(), conversation()?.session.id].filter(Boolean).join("\n")}>
          <Icon name={harness() === "codex" ? "codex" : "claude-code"} class="size-4 text-muted-foreground" />
          <select aria-label="Chat agent" value={harness()} class="min-w-0 rounded-md bg-transparent px-1 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary" onChange={(event) => setHarness(event.currentTarget.value === "claude" ? "claude" : "codex")}>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </div>
        <Show when={harness() === "codex"}>
        <Show when={undo()}><Button variant="ghost" class="text-muted-foreground" disabled={busy() || submitting() || loading() || checkpointing() || capturing() || analyzing() || transcribing()} title="Restore project files to before the last agent turn" onClick={() => setConfirmUndo(true)}>Undo last turn</Button></Show>
        <Show when={conversation()}>{(current) => <Button variant="ghost" class="gap-1 text-muted-foreground" disabled={busy() || submitting() || loading()} aria-label="Copy resume command" title="Continue this session in your terminal" onClick={() => void copyResume()}><Icon name={copiedSession() === current().session.id ? "confirm-check" : "external-link"} class="size-4" /><span class="hidden @[360px]:inline">{copiedSession() === current().session.id ? "Copied" : "Copy resume"}</span></Button>}</Show>
        <Button variant="ghost" class="text-muted-foreground" disabled={busy() || submitting() || loading()} onClick={() => void listSessions()}>Sessions</Button>
        <Button variant="ghost" size="icon-square" class="text-muted-foreground" aria-label="New Codex session" title="New session" disabled={busy() || submitting() || loading()} onClick={() => {
          setLoading(true);
          void mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "new", input: { dir: project.dir() } }).then((response) => { if (response.method === "new") useConversation(response.result); setShowSessions(false); }).catch(fail).finally(() => setLoading(false));
        }}><Icon name="plus-add-small" class="size-5" /></Button>
        </Show>
      </div>
      <Show when={harness() === "claude"}><ChatPanel embedded harness="claude" /></Show>
      <div class="flex min-h-0 flex-1 flex-col" classList={{ hidden: harness() !== "codex" }}>
      <Dialog open={confirmUndo()} onOpenChange={(open) => { if (!checkpointing()) setConfirmUndo(open); }}>
        <DialogPortal><DialogContent class="sm:max-w-sm" showCloseButton={!checkpointing()} onEscapeKeyDown={(event) => { if (checkpointing()) event.preventDefault(); }} onInteractOutside={(event) => { if (checkpointing()) event.preventDefault(); }}>
          <DialogTitle>{checkpointing() ? "Undoing last turn…" : "Undo last agent turn?"}</DialogTitle>
          <DialogDescription>Restore project files to before this turn, including any later edits. Current files are saved in Checkpoints first. Your chat draft and attachments stay.</DialogDescription>
          <div class="flex justify-end gap-2"><Button variant="ghost" disabled={checkpointing()} onClick={() => setConfirmUndo(false)}>Cancel</Button><Button disabled={busy() || checkpointing()} onClick={() => void undoLastTurn()}>Undo last turn</Button></div>
        </DialogContent></DialogPortal>
      </Dialog>
      <Show when={codexStatus()?.requiresLogin}><div class="flex flex-wrap items-center gap-x-2 px-3 py-2 text-xs text-muted-foreground"><p>Run <code>codex login</code> in your terminal to connect.</p><Button variant="link" disabled={loading()} onClick={() => void retryConnection()}>Check login</Button></div></Show>
      <Show when={showSessions()}>
        <div class="p-3 border-b border-border max-h-64 overflow-auto shrink-0">
          <form class="flex gap-2 mb-2" onSubmit={(event) => { event.preventDefault(); void listSessions(); }}>
            <input aria-label="Search Codex sessions" class="min-w-0 flex-1 text-xs bg-background rounded p-1.5" placeholder="Search local sessions" value={sessionSearch()} onInput={(event) => setSessionSearch(event.currentTarget.value)} />
            <Button variant="secondary" disabled={loading()} type="submit">Find</Button>
            <Button variant="ghost" onClick={() => setShowSessions(false)}>Close</Button>
          </form>
          <For each={sessions()}>{(session) => <button class="block text-left w-full py-2 border-b border-border disabled:opacity-50" disabled={loading()} onClick={() => void resume(session.id)}><p class="text-xs truncate">{session.name || session.preview || session.id}</p><p class="text-xxs text-muted-foreground truncate">{session.cwd}</p></button>}</For>
          <Show when={cursor()}><Button variant="link" disabled={loading()} onClick={() => void listSessions(true)}>Load more</Button></Show>
          <Show when={!sessions().length && !loading()}><p class="text-xs text-muted-foreground">No sessions found</p></Show>
        </div>
      </Show>
      <Transcript
        items={visibleItems()}
        sendCount={sendCount()}
        chatKey={conversation()?.session.id ?? "native-draft"}
        running={busy()}
        waiting={requests().length > 0 || approval() !== null}
        active={props.open && tab() === "Chat" && harness() === "codex"}
        onLoadEarlier={messageStart() > 0 ? () => setMessageStart((start) => Math.max(0, start - 60)) : undefined}
      />
      <div class="max-h-[45%] shrink-0 overflow-y-auto px-3"><For each={requests()}>{(request) => <CodexRequest request={request} onRespond={async (response) => {
        await mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "respond", input: { requestId: request.id, response } });
      }} />}</For></div>
      <Show when={approval()}><div class="p-3 border-t border-border shrink-0"><p class="text-xs font-medium mb-2">Codex requests approval</p><pre class="text-xxs whitespace-pre-wrap max-h-36 overflow-auto">{approval()?.text}</pre><div class="flex flex-wrap gap-2 mt-2"><Button disabled={approving()} onClick={() => void decide("accept")}>Allow once</Button><Button variant="secondary" disabled={approving()} onClick={() => void decide("decline")}>Decline</Button></div></div></Show>
      <Show when={draftError()}><p role="alert" class="text-xs text-destructive px-3 py-2">{draftError()}</p></Show>
      <Show when={error() || connectionError()}><p role="alert" class="text-xs text-destructive px-3 py-2 whitespace-pre-wrap max-h-28 overflow-auto">{error() || connectionError()}</p></Show>
      <Show when={connectionError() || (!ready() && !loading())}><Button variant="link" class="mx-3 mb-2 self-start" disabled={loading()} onClick={() => void retryConnection()}>Retry connection</Button></Show>
      <Show when={activity()}><p role="status" class="text-xs text-muted-foreground px-4 py-2 truncate" title={activity()}>{activity()}</p></Show>
      <div class="contents" onPaste={(event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        event.preventDefault();
        void addImages(files);
      }}>
        <Composer
          text={draft()}
          onText={setDraft}
          attachments={[]}
          onAttachments={() => {}}
          onFiles={(files) => void addImages(files)}
          model={{ harness: "codex", model: model() }}
          onModel={(ref) => setModelOverride(ref.model)}
          running={busy()}
          waiting={waiting()}
          steering
          blocked={null}
          hasContent={hasContent()}
          sendDisabled={readingImages() || submitting() || (busy() && !activeTurnId()) || !ready() || !draftReady() || loading() || capturing() || transcribing() || analyzing() || checkpointing()}
          label="Message Codex"
          placeholder={busy() ? "Steer Codex…" : "Describe a change, or use $skills…"}
          inputRef={(element) => { input = element; }}
          catalog={capabilities}
          skills={skills()}
          onSkills={setSkills}
          onSend={() => savedDraft.trackSubmission(send())}
          onStop={() => void mainBridge.call(MAIN_CHANNELS.CODEX_REQUEST, { method: "cancel", input: { dir: project.dir() } }).catch(fail)}
          context={<>
        <div class="flex items-center gap-1.5 px-3 pt-2.5 text-xxs text-muted-foreground" title="Selection and playhead are attached when you send">
          <Icon name={selection.nodes().length ? "move-small" : "scene-frame-small"} class="size-4" />
          <p class="truncate">{selection.nodes().length ? selection.nodes().map((node) => node.get(Name)?.value || node.get(Source)?.value || "Untitled layer").join(", ") : selectedAsset.asset() ? selectedAsset.asset()!.path : "Current scene and playhead"}</p>
        </div>
      <Show when={area()}>{(attachment) => <div class="px-3 pt-2 flex gap-2 items-center shrink-0">
        <button type="button" aria-label="Edit area annotation" class="shrink-0 focus-visible:ring-1 focus-visible:ring-primary" disabled={submitting()} onClick={() => setAreaFrame(attachment().snapshot)}><img src={attachment().annotation.imageUrl} alt="Marked area" class="w-24 max-h-16 object-contain bg-background" /></button>
        <div class="min-w-0 flex-1 text-xxs"><p>Area at {attachment().annotation.time.toFixed(2)}s</p><p class="truncate text-muted-foreground" title={attachment().annotation.note}>{attachment().annotation.note || attachment().annotation.sceneName}</p></div>
        <Button variant="ghost" size="icon-square" aria-label="Remove area annotation" disabled={submitting()} onClick={() => setArea(undefined)}><Icon name="close-remove-small" class="size-4" /></Button>
      </div>}</Show>
      <Show when={timeRange()}>{(timing) => <div class="px-3 pt-2 flex items-center gap-2 text-xs" aria-label="Attached time range">
        <button type="button" class="min-w-0 flex-1 text-left hover:underline focus-visible:ring-1 focus-visible:ring-primary" disabled={submitting() || capturing()} onClick={() => void markTime()} title={timing().sceneName}>{timing().start.toFixed(2)} to {timing().end.toFixed(2)}s<span class="block truncate text-xxs text-muted-foreground">{timing().sceneName}</span></button>
        <Button variant="ghost" size="icon-square" aria-label="Remove time range" disabled={submitting()} onClick={() => setTimeRange(undefined)}><Icon name="close-remove-small" class="size-4" /></Button>
      </div>}</Show>
      <Show when={references().length}>
        <div class="px-3 py-2 space-y-1 max-h-36 overflow-y-auto shrink-0" aria-label="Catalog references">
          <For each={references()}>{(reference) => <div class="flex gap-2 items-center text-xs rounded-md bg-secondary pl-2">
            <Icon name="attachment" class="size-4 text-muted-foreground" />
            <p class="min-w-0 flex-1 truncate" title={`${reference.catalog === "hyfrme" ? "Hyfrme" : "HyperFrames"}: ${reference.item.description}`}>{reference.item.title}</p>
            <Button variant="ghost" size="icon-square" aria-label={`Remove ${reference.item.title} reference`} disabled={submitting()} onClick={() => setReferences((current) => current.filter((item) => item !== reference))}><Icon name="close-remove-small" class="size-4" /></Button>
          </div>}</For>
        </div>
      </Show>
      <Show when={videoContext()}>{(attachment) => <div class="mx-3 mt-2 flex items-center gap-2 text-xs bg-secondary rounded-md pl-2" aria-label="Attached video context">
        <Icon name="attachment" class="size-4 text-muted-foreground" /><span class="flex-1 min-w-0 truncate" title={`${attachment().sceneName}: ${attachment().frames.length} sampled frames${attachment().fullTranscript ? " and full transcript" : ", no speech transcript"}`}>Video / {attachment().frames.length} frames{attachment().fullTranscript ? " + transcript" : ""}</span>
        <Button variant="ghost" size="icon-square" aria-label="Remove video context" disabled={submitting()} onClick={() => setVideoContext(undefined)}><Icon name="close-remove-small" class="size-4" /></Button>
      </div>}</Show>
      <Show when={transcript()}>{(attachment) => <div class="mx-3 mt-2 flex items-center gap-2 text-xs bg-secondary rounded-md pl-2" aria-label="Attached full transcript">
        <Icon name="attachment" class="size-4 text-muted-foreground" /><span class="flex-1 min-w-0 truncate" title={attachment().path}>Transcript / {attachment().sceneName}</span>
        <Button variant="ghost" size="icon-square" aria-label="Remove full transcript" disabled={submitting()} onClick={() => setTranscript(undefined)}><Icon name="close-remove-small" class="size-4" /></Button>
      </div>}</Show>
      <For each={animationReferences()}>{(item) => <div class="mx-3 mt-2 flex items-center gap-2 text-xs bg-secondary rounded-md pl-2" aria-label="Animation reference">
        <Icon name="attachment" class="size-4 text-muted-foreground" /><span class="flex-1 min-w-0 truncate">{item.engine === "manim" ? "Manim" : "HyperFrames"} / {item.id}</span>
        <Button variant="ghost" size="icon-square" aria-label={`Remove ${item.id} animation reference`} disabled={submitting()} onClick={() => setAnimationReferences((current) => current.filter((entry) => entry !== item))}><Icon name="close-remove-small" class="size-4" /></Button>
      </div>}</For>
      <Show when={effectReference()}>{(reference) => <div class="mx-3 mt-2 flex items-center gap-2 text-xs bg-secondary rounded-md pl-2" aria-label="Effect reference">
        <Icon name="fx" class="size-4 text-muted-foreground" /><span class="flex-1 min-w-0 truncate">Effect / {reference().definition.title}</span>
        <Button variant="ghost" size="icon-square" aria-label={`Remove ${reference().definition.title} reference`} disabled={submitting()} onClick={() => setEffectReference(undefined)}><Icon name="close-remove-small" class="size-4" /></Button>
      </div>}</Show>
        <div class="contents"><ChatImages images={images()} showButton={false} inputRef={(element) => { imageInput = element; }} disabled={submitting() || readingImages()} onAdd={(files) => void addImages(files)} onRemove={(image) => setImages((current) => current.filter((item) => item !== image))} />
          <Show when={readingImages()}><p role="status" class="px-2 text-xs text-muted-foreground">Loading images…</p></Show>
        </div>
          </>}
          modelControl={<div class="min-w-0 flex-1">
        <Show when={codexStatus()}>
          <div class="flex flex-wrap gap-1 px-2 text-xxs">
            <select aria-label="Codex model" title="Model" class="min-w-0 max-w-full flex-1 bg-transparent hover:bg-secondary rounded-md px-1 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50" disabled={busy() || submitting() || loading()} value={model()} onChange={(event) => {
              const next = event.currentTarget.value;
              const option = codexStatus()?.models.find((item) => item.model === next);
              const previousEffort = effort();
              setModelOverride(next);
              setEffortOverride(option?.supportedReasoningEfforts.some((item) => item.reasoningEffort === previousEffort) ? previousEffort : option?.defaultReasoningEffort);
            }}>
              <Show when={!modelOption()}><option value={model()}>{model() || "Configured model"}</option></Show>
              <For each={codexStatus()?.models}>{(option) => <option value={option.model}>{option.name}</option>}</For>
            </select>
            <select aria-label="Codex reasoning" title="Reasoning effort" class="min-w-0 max-w-32 bg-transparent hover:bg-secondary text-muted-foreground rounded-md px-1 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-primary disabled:opacity-50" disabled={busy() || submitting() || loading() || !modelOption()?.supportedReasoningEfforts.length} value={effort()} onChange={(event) => setEffortOverride(event.currentTarget.value)}>
              <Show when={!modelOption()?.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort())}><option value={effort()}>{effort() || "Default reasoning"}</option></Show>
              <For each={modelOption()?.supportedReasoningEfforts}>{(option) => <option value={option.reasoningEffort} title={option.description}>{option.reasoningEffort === "xhigh" ? "Extra high" : option.reasoningEffort.charAt(0).toUpperCase() + option.reasoningEffort.slice(1)}</option>}</For>
            </select>
          </div>
        </Show>
          </div>}
          controls={
        <div class="flex flex-col items-stretch gap-0.5 p-1 [&_button]:justify-start"><Button type="button" variant="ghost" class="gap-2 text-muted-foreground" disabled={submitting() || readingImages()} onClick={() => imageInput?.click()}><Icon name="attachment" class="size-4" />Attach images</Button><Show when={selectedAsset.asset()?.type === "IMAGE"}><Button type="button" variant="ghost" disabled={submitting() || readingImages()} onClick={() => void attachSelectedImage()}>Attach selected image</Button></Show><CodexCapabilitiesPicker catalog={capabilities} disabled={submitting() || loading()} onSkill={(skill) => {
          const next = insertSkillMention(draft(), skill, { start: input?.selectionStart ?? draft().length, end: input?.selectionEnd ?? draft().length });
          setSkills((current) => [...retainSkillMentions(draft(), next.text, current).filter((item) => item.path !== skill.path && item.name !== skill.name), skill]);
          setDraft(next.text);
          queueMicrotask(() => { input?.focus(); input?.setSelectionRange(next.caret, next.caret); });
        }} /><Button type="button" variant="ghost" class="gap-1 text-muted-foreground" disabled={submitting() || capturing() || analyzing()} onClick={() => void markArea()}><Icon name="rectangle-small" class="size-4" />Mark area</Button><Button type="button" variant="ghost" class="text-muted-foreground" disabled={submitting() || capturing() || analyzing()} onClick={() => void markTime()}>Time range</Button><Button type="button" variant="ghost" class="text-muted-foreground" disabled={submitting() || capturing() || analyzing() || checkpointing()} onClick={() => setTab("Transcript")}>Transcript</Button><VideoContextButton disabled={submitting() || capturing() || transcribing()} onAttach={(attachment) => { if (attachment.projectDir !== project.dir()) { setError("The project folder changed. Attach video context again."); return; } setVideoContext(attachment); setTranscript(undefined); setError(""); }} onBusyChange={setAnalyzing} onError={fail} /></div>
          }
        />
      </div>
      </div>
    </TabsContent>
    <TabsContent value="Tools" forceMount class="min-h-0 overflow-hidden" classList={{ hidden: !toolTabs.some((name) => name === tab()) }}>
    <Show when={tab() === "Editor"}><Inspector embedded /></Show>
    <Show when={visited().includes("Effects")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "Effects" }}><EffectsPanel disabled={busy() || transcribing() || checkpointing()} onReference={(definition, settings) => {
      setHarness("codex");
      setEffectReference({ definition, settings });
      setTab("Chat");
      queueMicrotask(() => input?.focus());
    }} /></div></Show>
    <Show when={visited().includes("Transcript")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "Transcript" }}><TranscriptPanel editingDisabled={busy()} disabled={submitting() || checkpointing() || analyzing() || capturing()} onBusyChange={setTranscribing} beforeEdit={async (label) => { await saveProjectCheckpoint(label); setCheckpointRevision((revision) => revision + 1); }} onAttach={(attachment) => {
      if (attachment.projectDir !== project.dir()) { setError("The project folder changed. Attach the transcript again."); return; }
      setHarness("codex");
      setTranscript(attachment);
      setError("");
      setTab("Chat");
      queueMicrotask(() => input?.focus());
    }} /></div></Show>
    <Show when={visited().includes("Checkpoints")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "Checkpoints" }}><CheckpointPanel active={props.open && tab() === "Checkpoints"} disabled={busy() || transcribing() || analyzing()} revision={checkpointRevision()} onBusyChange={setCheckpointing} /></div></Show>
    <Show when={tab() === "Audio"}><div class="h-full min-h-0 overflow-y-auto"><div class="h-96 max-h-full"><Soundboard /></div><p class="px-4 py-3 text-xs text-muted-foreground">Play the scene to see audio levels.</p></div></Show>
    <Show when={visited().includes("Assets")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "Assets" }}><AssetSearch onAsk={ask} /></div></Show>
    </TabsContent>
    <Show when={visited().includes("Animations")}><TabsContent value="Animations" forceMount class="min-h-0" classList={{ hidden: tab() !== "Animations" }}><AnimationsPanel active={props.open && tab() === "Animations"} revision={animationRevision()} onAsk={ask} onBrowse={() => setTab("HyperFrames")} onReference={(animation) => {
      setHarness("codex");
      setAnimationReferences((current) => [...current.filter((item) => item.id !== animation.id), animation]);
      setTab("Chat");
      queueMicrotask(() => input?.focus());
    }} /></TabsContent></Show>
    <TabsContent value="Catalog" forceMount class="min-h-0" classList={{ hidden: !catalogTabs.some((name) => name === tab()) }}>
    <Show when={visited().includes("Motion")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "Motion" }}><MotionLibrary /></div></Show>
    <Show when={visited().includes("HyperFrames")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "HyperFrames" }}><HyperframesCatalog active={props.open && tab() === "HyperFrames"} onReference={reference} /></div></Show>
    <Show when={visited().includes("Templates")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "Templates" }}><HyperframesCatalog active={props.open && tab() === "Templates"} templates onReference={reference} /></div></Show>
    <Show when={visited().includes("Hyfrme")}><div class="h-full min-h-0" classList={{ hidden: tab() !== "Hyfrme" }}><HyperframesCatalog active={props.open && tab() === "Hyfrme"} catalog="hyfrme" onReference={reference} /></div></Show>
    </TabsContent>
    <Show when={areaFrame()}>{(snapshot) => <AreaAnnotation snapshot={snapshot()} initial={area()?.snapshot === snapshot() ? area()?.annotation : undefined} onClose={() => setAreaFrame(undefined)} onAttach={(attachment) => {
      setArea(attachment);
      setAreaFrame(undefined);
      queueMicrotask(() => input?.focus());
    }} />}</Show>
    <Show when={rangeScene()}>{(snapshot) => <TimeRangePicker snapshot={snapshot()} initial={timeRange()} onClose={() => setRangeScene(undefined)} onAttach={(range) => {
      setTimeRange(range);
      setRangeScene(undefined);
      queueMicrotask(() => input?.focus());
    }} />}</Show>
  </WorkspaceTabs>;
}
