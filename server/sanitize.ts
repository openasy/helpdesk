// Email HTML, made safe to show beside the team's own pages. An email is written by anyone, so only text formatting is
// kept: no script, style, form, frame, SVG or event handler, no style attributes (they can load addresses), and no
// remote images (they tell the sender when and where the email was opened). Inline images sent with the email (cid:)
// are kept, pointed at the attachment Helpdesk stored. Links go to http(s) and mailto only and open in a new tab.
import sanitizeHtml from "sanitize-html";

const TAGS = [
  "p",
  "br",
  "div",
  "span",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "img",
  "center",
];

/**
 * Sanitizes an email's HTML. `inline` maps a Content-ID (without angle brackets) to the address its stored attachment
 * is served at; images that are neither inline nor small data: images are removed.
 */
export function sanitizeEmail(html: string, inline: Record<string, string> = {}): string {
  return sanitizeHtml(html, {
    allowedTags: TAGS,
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "width", "height"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["data"] },
    allowProtocolRelative: false,
    // Their text goes with them; style, script and title are dropped whole.
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "title", "head"],
    transformTags: {
      a: (tag, attribs) => ({ tagName: tag, attribs: { ...attribs, rel: "noopener noreferrer nofollow", target: "_blank" } }),
      img: (tag, attribs) => {
        const src = (attribs.src ?? "").trim();
        const cid = /^cid:(.+)$/i.exec(src)?.[1]?.replace(/^<|>$/g, "");
        if (cid && inline[cid]) return { tagName: tag, attribs: { ...attribs, src: inline[cid] } };
        if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(src) && src.length < 2_000_000) return { tagName: tag, attribs };
        // No src: the filter below removes it.
        return { tagName: tag, attribs: {} };
      },
    },
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  }).trim();
}

/** Plain text as HTML, for the replies Helpdesk sends: escaped, with paragraphs and line breaks. */
export function textToHtml(text: string): string {
  const esc = text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}
