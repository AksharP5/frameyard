import type { CodexSkill } from "@desktop/codex-capabilities";

/** The skill token at the caret, including its untyped suffix when editing it. */
export function skillMentionAt(text: string, start: number, end = start) {
  if (start !== end || start < 0 || start > text.length) return;
  const match = /(?:^|\s)\$([\w:.-]*)$/.exec(text.slice(0, start));
  if (!match) return;
  const suffix = /^[\w:.-]*/.exec(text.slice(start))![0];
  return { query: match[1], start: start - match[1].length - 1, end: start + suffix.length };
}

export function findSkillMentions(skills: readonly CodexSkill[], query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const nameQuery = query.toLowerCase();
  return skills.filter((skill) => {
    const searchable = `${skill.name} ${skill.description}`.toLowerCase();
    return words.every((word) => searchable.includes(word));
  }).sort((a, b) => {
    const rank = (name: string) => name.toLowerCase() === nameQuery ? 0 : name.toLowerCase().startsWith(nameQuery) ? 1 : 2;
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);
  }).slice(0, 12);
}

function mentions(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)\\$${escaped}(?![\\w:.-])`, "g").test(text);
}

/** Explicit picker attachments from older drafts stay attached until removed. */
export function retainSkillMentions(previous: string, next: string, selected: readonly CodexSkill[]) {
  return selected.filter((skill) => !mentions(previous, skill.name) || mentions(next, skill.name));
}

export function removeSkillMention(text: string, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(^|\\s)\\$${escaped}(?![\\w:.-])[ \\t]?`, "g"), "$1");
}

export function insertSkillMention(text: string, skill: CodexSkill, range = { start: text.length, end: text.length }) {
  const prefix = text.slice(0, range.start);
  const separator = prefix && !/\s$/.test(prefix) ? " " : "";
  const inserted = `${prefix}${separator}$${skill.name} `;
  return { text: inserted + text.slice(range.end).replace(/^ /, ""), caret: inserted.length };
}
