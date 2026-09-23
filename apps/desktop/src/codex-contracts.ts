import type { CodexImage } from "./codex-image-contracts";
import type { CodexPendingRequest, CodexRequestResponse } from "./codex-requests";
import type { CodexCapabilities, CodexSkill } from "./codex-capabilities";
import type { Annotation, TimeRange } from "./annotation-contracts";
import type { VideoFrames } from "./video-frame-contracts";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type CodexSession = {
  id: string;
  name: string;
  preview: string;
  cwd: string;
  updatedAt: number;
  source: string;
};

export type CodexMessage = { id: string; role: "user" | "assistant"; text: string };
export type CodexSettings = { model: string | null; reasoningEffort: string | null };
export type CodexModel = {
  id: string;
  model: string;
  name: string;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[];
  defaultReasoningEffort: string;
};
export type CodexUndo = { threadId: string; turnId: string; checkpointId: string };
export type CodexConversation = { session: CodexSession; messages: CodexMessage[]; settings: CodexSettings; activeTurn?: boolean; activeTurnId?: string; undo?: CodexUndo; pendingRequests?: CodexPendingRequest[]; pendingApproval?: Extract<CodexEvent, { type: "approval" }> };

export type CodexCommands = {
  capabilities: { input: { dir: string }; result: CodexCapabilities };
  status: { input: { dir?: string }; result: {
    account: { type: string; plan: string | null } | null;
    requiresLogin: boolean;
    models: CodexModel[];
    defaults: CodexSettings;
  } };
  sessions: { input: { dir: string; cursor?: string; search?: string }; result: { sessions: CodexSession[]; cursor: string | null } };
  load: { input: { dir: string; threadId?: string }; result: CodexConversation | null };
  new: { input: { dir: string }; result: CodexConversation };
  release: { input: { dir: string }; result: { command: string } };
  send: { input: { dir: string; text: string; context: unknown; images?: CodexImage[]; expectedTurnId?: string; skills?: Pick<CodexSkill, "name" | "path">[]; annotation?: Annotation; timeRange?: TimeRange; videoFrames?: VideoFrames; model?: string; reasoningEffort?: string }; result: { threadId: string; turnId: string } };
  undo: { input: { dir: string; threadId: string; turnId: string }; result: null };
  cancel: { input: { dir: string }; result: null };
  respond: { input: { requestId: string; response: CodexRequestResponse }; result: null };
  approve: { input: { requestId: string; decision: "accept" | "decline" }; result: null };
};

export type CodexRequest = { [K in keyof CodexCommands]: { method: K; input: CodexCommands[K]["input"] } }[keyof CodexCommands];
export type CodexResponse = { [K in keyof CodexCommands]: { method: K; result: CodexCommands[K]["result"] } }[keyof CodexCommands];

export type CodexTool = { name: string; description: string; inputSchema: JsonValue };
export type CodexToolResult = {
  contentItems: ({ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string })[];
  success: boolean;
};

export type CodexEventData =
  | { type: "delta"; itemId: string; text: string }
  | { type: "activity"; text: string }
  | { type: "turn"; status: "started" | "completed" | "interrupted" | "failed"; error?: string; undo?: CodexUndo }
  | { type: "approval"; requestId: string; kind: "command" | "file"; text: string }
  | { type: "requests"; requests: CodexPendingRequest[] }
  | { type: "generated"; asset: JsonValue };

export type CodexEvent = { dir: string; threadId: string; turnId?: string } & CodexEventData;

export type CodexOptions = {
  dataDir: string;
  binary?: string;
  onEvent: (event: CodexEvent) => void;
  tools?: CodexTool[];
  runTool: (dir: string, name: string, args: unknown) => Promise<CodexToolResult>;
  restoreCheckpoint?: (dir: string, id: string) => Promise<unknown>;
  importGenerated?: (dir: string, image: { savedPath?: string; result: string; prompt: string }) => Promise<JsonValue>;
};
