/**
 * Model text for a public comment: no @-mentions (GitHub would notify those people), no links
 * and no raw HTML (the text may come from the student's materials). Code spans and blocks are
 * left as they are: GitHub neither links, mentions nor renders HTML inside them.
 */
export function publicText(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\b(?:https?:\/\/|www\.)[^\s`]*[^\s`.,;:!?)»"']/gi, (url) => `\`${url}\``)
            .replace(/(^|[^\w])@(?=[A-Za-z0-9])/g, "$1@\u200b")
            .replace(/</g, "&lt;"),
    )
    .join("");
}
