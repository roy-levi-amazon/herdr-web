import ReactMarkdown from "react-markdown";
import type { UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

export type NoteMarkdownPreviewProps = {
  body: string;
};

export default function NoteMarkdownPreview({ body }: NoteMarkdownPreviewProps) {
  if (!body.trim()) {
    return <span className="note-body-preview-empty">No content</span>;
  }
  return (
    <ReactMarkdown
      disallowedElements={["img"]}
      remarkPlugins={[remarkGfm]}
      urlTransform={safeMarkdownUrl}
      components={{
        a: ({ children, href, ...props }) =>
          href ? (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),
      }}
    >
      {body}
    </ReactMarkdown>
  );
}

const safeMarkdownUrl: UrlTransform = (url, key) => {
  if (key !== "href") {
    return null;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
};
