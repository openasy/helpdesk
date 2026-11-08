// Emails in and out. In: an email read over IMAP is parsed (mailparser), checked for loops, auto-replies and bounces,
// and threaded into its ticket. Out: a reply carries a Message-ID of ours, In-Reply-To and References, so the customer's
// mail app threads it and their answer comes back to the same ticket; the ticket's number goes in the subject, the reply
// address, or both, for mail apps that drop those headers.
import { createHmac, randomBytes } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  /** Content-ID without the angle brackets, for images shown in the HTML. */
  contentId: string | null;
  data: Buffer;
}

export interface Inbound {
  /** With the angle brackets; null when the email had none. */
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  from: { email: string; name: string } | null;
  /** To and Cc, and the envelope recipient headers servers add (Delivered-To, X-Original-To). */
  recipients: string[];
  cc: string[];
  subject: string;
  text: string;
  html: string | null;
  date: number | null;
  /** Why the email is automatic (an out-of-office, a list, a notification), or null for a person's email. */
  auto: string | null;
  /** Set when the email says a message could not be delivered. */
  bounce: { recipients: string[]; ours: string[] } | null;
  /** The ticket number in our own header, when the email is one Helpdesk sent. */
  ours: string | null;
  attachments: Attachment[];
}

const ID = /<[^<>\s]+@[^<>\s]+>/g;
/** Message-IDs Helpdesk makes: <hd.1001.0123456789ab@example.com>. */
const OUR_ID = /<hd\.(\d{1,12})\.[0-9a-f]{12}@[^<>\s]+>/gi;
export const HEADER = "X-OpenAsy-Helpdesk";
const AUTO_SUBJECT =
  /^\s*(auto(matic)?[ -]?(reply|response|antwort)|out of (the )?office|abwesenheit\w*|automatische antwort|otomatik (yan[ıi]t|cevap)|ofis d[ıi][şs][ıi]|undeliverable|undelivered mail|mail delivery failed)\s*(\([^)]{0,40}\))?\s*:/i;

const ids = (v: unknown): string[] => {
  const s = Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "";
  return [...new Set(s.match(ID) ?? [])].slice(0, 100);
};

function addresses(v: AddressObject | AddressObject[] | undefined): Array<{ email: string; name: string }> {
  const list = (Array.isArray(v) ? v : v ? [v] : []).flatMap((a) => a.value);
  const flat = list.flatMap((a) => (a.group ? a.group : [a]));
  return flat.filter((a) => a.address).map((a) => ({ email: a.address!.trim().toLowerCase(), name: (a.name ?? "").trim() }));
}

/** Reads a raw email. */
export async function parseEmail(raw: Buffer | string): Promise<Inbound> {
  const p = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: 2_000_000 });
  const header = (name: string): string | null => {
    const line = p.headerLines.find((h) => h.key === name.toLowerCase());
    return line ? line.line.slice(line.line.indexOf(":") + 1).trim() : null;
  };
  const from = addresses(p.from)[0] ?? null;
  const to = addresses(p.to).map((a) => a.email);
  const cc = addresses(p.cc).map((a) => a.email);
  const envelope = ["delivered-to", "x-original-to", "envelope-to", "x-envelope-to"]
    .flatMap((k) => p.headerLines.filter((h) => h.key === k).map((h) => h.line.slice(h.line.indexOf(":") + 1).trim()))
    .flatMap((v) => v.match(/[^\s<>,;]+@[^\s<>,;]+/g) ?? [])
    .map((v) => v.toLowerCase());
  const subject = (p.subject ?? "").trim();
  const text = (p.text ?? "").replace(/\r\n/g, "\n");
  const rawText = typeof raw === "string" ? raw : raw.toString("latin1");

  // ------------------------------------------------------------ automatic emails (RFC 3834 and what servers really send)
  let auto: string | null = null;
  const autoSubmitted = header("auto-submitted");
  const precedence = header("precedence")?.toLowerCase();
  if (autoSubmitted && autoSubmitted.toLowerCase().split(";")[0]!.trim() !== "no") auto = `Auto-Submitted: ${autoSubmitted.split(";")[0]}`;
  else if (header("x-autoreply") || header("x-autorespond") || header("x-autoresponse") || header("x-auto-reply")) auto = "X-Autoreply";
  else if (precedence && ["bulk", "junk", "list", "auto_reply"].includes(precedence)) auto = `Precedence: ${precedence}`;
  else if (header("list-id") || header("list-unsubscribe")) auto = "a mailing list (List-Id)";
  else if (header("x-ms-exchange-generated-message-source") || header("x-ms-exchange-inbox-rules-loop")) auto = "an Exchange rule";
  else if (AUTO_SUBJECT.test(subject)) auto = "an automatic subject";

  // ------------------------------------------------------------ bounces (RFC 3464 reports, and mailer daemons)
  const contentType = header("content-type")?.toLowerCase() ?? "";
  const daemon = !!from && /^(mailer-daemon|postmaster|mail-daemon|mailerdaemon)@/i.test(from.email);
  const failed = header("x-failed-recipients");
  const report = contentType.includes("multipart/report") && contentType.includes("delivery-status");
  const nullSender = /^<\s*>$/.test(header("return-path") ?? "x");
  let bounce: Inbound["bounce"] = null;
  if (report || failed || daemon || (nullSender && AUTO_SUBJECT.test(subject))) {
    const recipients = new Set<string>();
    for (const r of failed?.split(",") ?? []) if (r.trim()) recipients.add(r.trim().toLowerCase());
    for (const m of rawText.matchAll(/^Final-Recipient:\s*rfc822;\s*<?([^\s<>]+@[^\s<>]+?)>?\s*$/gim)) recipients.add(m[1]!.toLowerCase());
    bounce = { recipients: [...recipients], ours: [...new Set([...rawText.matchAll(OUR_ID)].map((m) => m[0].toLowerCase()))] };
    auto = auto ?? "a bounce";
  }

  const attachments: Attachment[] = p.attachments
    .filter((a) => a.contentType !== "message/delivery-status" && a.content.length > 0)
    .slice(0, 50)
    .map((a) => ({
      filename: (a.filename ?? (a.contentType.startsWith("image/") ? "image" : "attachment")).slice(0, 200),
      contentType: a.contentType.slice(0, 100),
      size: a.content.length,
      contentId: a.cid ? a.cid.replace(/^<|>$/g, "") : null,
      data: a.content,
    }));

  return {
    messageId: ids(p.messageId)[0] ?? null,
    inReplyTo: ids(p.inReplyTo),
    references: ids(p.references),
    from,
    recipients: [...new Set([...to, ...cc, ...envelope])],
    cc,
    subject,
    text,
    html: typeof p.html === "string" ? p.html : null,
    date: p.date ? p.date.getTime() : null,
    auto,
    bounce,
    ours: header(HEADER),
    attachments,
  };
}

/** Ticket numbers Helpdesk's own Message-IDs in a list name. */
export function ourTickets(messageIds: string[]): number[] {
  return [...new Set(messageIds.flatMap((id) => [...id.matchAll(OUR_ID)].map((m) => Number(m[1]))))];
}

/** A Message-ID of ours, for the ticket, on the support address's domain. */
export function newMessageId(ticket: number, address: string): string {
  return `<hd.${ticket}.${randomBytes(6).toString("hex")}@${address.split("@")[1] ?? "helpdesk.invalid"}>`;
}

/** The ticket number in a subject such as "Re: Invoices fail [#1001]". */
export function subjectTicket(subject: string): number | null {
  const m = /\[#(\d{1,12})\]/.exec(subject);
  return m ? Number(m[1]) : null;
}

/** The reply address with the ticket in it: support+1001-a1b2c3d4@example.com. The tag makes the address unguessable. */
export function replyAddress(address: string, ticket: number, secret: string): string {
  const [local, domain] = address.split("@");
  return `${local}+${ticket}-${tag(ticket, secret)}@${domain}`;
}

const tag = (ticket: number, secret: string) => createHmac("sha256", secret).update(String(ticket)).digest("hex").slice(0, 8);

/** The ticket a reply address of ours names, when its tag is right. */
export function addressTicket(recipients: string[], ours: string[], secret: string): number | null {
  for (const r of recipients) {
    const m = /^([^+@]+)\+(\d{1,12})-([0-9a-f]{8})@(.+)$/.exec(r);
    if (m && ours.includes(`${m[1]}@${m[4]}`) && tag(Number(m[2]), secret) === m[3]) return Number(m[2]);
  }
  return null;
}

/** "Re: " once, and the ticket's number once. */
export function replySubject(subject: string, ticket: number, withNumber: boolean): string {
  const base = subject.replace(/\s*\[#\d{1,12}\]/g, "").trim() || "(no subject)";
  const re = /^(re|aw|ynt|sv|antw)\s*:/i.test(base) ? base : `Re: ${base}`;
  return withNumber ? `${re} [#${ticket}]` : re;
}

/** The subject of a new ticket, without the Re:, Fwd: and our number a reply brings. */
export function cleanSubject(subject: string): string {
  let s = subject.replace(/\s*\[#\d{1,12}\]/g, "").trim();
  for (let i = 0; i < 5; i++) s = s.replace(/^(re|aw|fwd?|wg|ynt|ilt|sv|antw)\s*:\s*/i, "");
  return s.slice(0, 300) || "(no subject)";
}

const QUOTE_HEADS = [
  /^On .{1,300}wrote:\s*$/,
  /^Am .{1,300}schrieb .{0,300}:\s*$/,
  /^.{1,300}tarihinde .{0,300}(şunu yazdı|yazdı):\s*$/,
  /^Le .{1,300}a écrit\s*:\s*$/,
  /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Orijinal [İi]leti|Özgün [İi]leti|Forwarded message)\s*-{2,}/i,
  /^_{10,}\s*$/,
];
const OUTLOOK_FROM = /^\*?(From|Von|Kimden|De):\*?\s/;
const OUTLOOK_NEXT = /^\*?(Sent|Date|Gesendet|Datum|Gönderildi|Tarih|Envoyé|To|An|Kime|À):\*?\s/;

/** The part of a reply that is new: what comes before the quoted email ("On ... wrote:", "> ..."). */
export function newPart(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    const joined = `${line} ${(lines[i + 1] ?? "").trim()}`;
    if (QUOTE_HEADS.some((r) => r.test(line)) || (/wrote:\s*$|schrieb:?\s*$|yazdı:\s*$/.test(joined) && /^(On|Am)\s/.test(line))) {
      cut = i;
      break;
    }
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_NEXT.test(l.trim()))) {
      cut = i;
      break;
    }
  }
  // Then any block of "> " lines at the end.
  let end = cut;
  while (end > 0 && (lines[end - 1]!.trim().startsWith(">") || !lines[end - 1]!.trim())) end--;
  const kept = lines.slice(0, end).join("\n").trim();
  return kept || text.trim();
}

/** The previous message, quoted under a reply, as mail apps do. */
export function quote(text: string, who: string, at: Date, locale: string): string {
  const when = at.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  const head = locale === "de" ? `Am ${when} UTC schrieb ${who}:` : locale === "tr" ? `${when} UTC tarihinde ${who} yazdı:` : `On ${when} UTC, ${who} wrote:`;
  return `${head}\n${text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}`;
}
