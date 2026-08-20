import { DetachedLink } from "./DetachedLink";

function decodeTextEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
}

export function FormattedText({ text = "" }: { text?: string }) {
  const decoded = decodeTextEntities(text);
  const parts = decoded.split(/(\[[^\]]+\]\((?:https?:\/\/|\/(?:api\/artifacts|review-artifacts)\/)[^)]+\)|https?:\/\/[^\s<]+|`[^`]+`|\n)/g);
  return (
    <>
      {parts.map((part, index) => {
        const link = part.match(/^\[([^\]]+)\]\(((?:https?:\/\/|\/(?:api\/artifacts|review-artifacts)\/)[^)]+)\)$/);
        if (link) return <DetachedLink key={index} href={link[2]}>{link[1]}</DetachedLink>;
        if (part === "\n") return <br key={index} />;
        if (/^https?:\/\//.test(part)) return <DetachedLink key={index} href={part}>{part}</DetachedLink>;
        if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
        return part;
      })}
    </>
  );
}
