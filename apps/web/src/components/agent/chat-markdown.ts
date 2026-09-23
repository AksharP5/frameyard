import { Marked } from "marked";
import DOMPurify from "dompurify";

const markdown = new Marked({ breaks: true, gfm: true });

export function renderChatMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.parse(text, { async: false }), {
    ALLOWED_TAGS: ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a", "table", "thead", "tbody", "tr", "th", "td"],
    ALLOWED_ATTR: ["href", "title", "start"],
    ALLOWED_URI_REGEXP: /^https?:\/\//i,
  });
}
