import { describe, expect, it } from "vitest";
import type { ChatSummary } from "@diffusionstudio/agent-chat";
import { mergeChatList } from "./chat-list";

const chat = (id: string, updatedAt = 1, status: ChatSummary["status"] = "idle"): ChatSummary => ({
  id, projectId: "project", title: id, harness: "codex", model: "test",
  status, createdAt: 1, updatedAt,
});

describe("mergeChatList", () => {
  it("keeps a new chat accepted after the list request started", () => {
    expect(mergeChatList([chat("old")], [chat("new", 2, "running"), chat("old")], [chat("old")]))
      .toEqual([chat("new", 2, "running"), chat("old")]);
  });

  it("does not resurrect a chat deleted while the request was in flight", () => {
    expect(mergeChatList([chat("deleted")], [], [chat("deleted")])).toEqual([]);
  });

  it("keeps a status update even when timestamps match", () => {
    expect(mergeChatList([chat("turn")], [chat("turn", 1, "running")], [chat("turn")]))
      .toEqual([chat("turn", 1, "running")]);
  });

  it("accepts server removals when the local list did not change", () => {
    expect(mergeChatList([chat("removed")], [chat("removed")], [])).toEqual([]);
  });
});
