import type { ChatSummary } from "@diffusionstudio/agent-chat";

/** Apply a list response without discarding chats changed while it was loading. */
export function mergeChatList(before: ChatSummary[], current: ChatSummary[], fetched: ChatSummary[]): ChatSummary[] {
  const baseline = new Map(before.map((chat) => [chat.id, chat]));
  const currentById = new Map(current.map((chat) => [chat.id, chat]));
  const merged = new Map(fetched.filter((chat) => !baseline.has(chat.id) || currentById.has(chat.id)).map((chat) => [chat.id, chat]));

  for (const chat of current) {
    const previous = baseline.get(chat.id);
    if (previous && previous.title === chat.title && previous.harness === chat.harness
      && previous.model === chat.model && previous.status === chat.status
      && previous.updatedAt === chat.updatedAt) continue;
    const remote = merged.get(chat.id);
    if (!remote || chat.updatedAt >= remote.updatedAt) merged.set(chat.id, chat);
  }

  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
