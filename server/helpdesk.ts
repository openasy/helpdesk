// Helpdesk: tickets from emails, forms and chats, in the queues the settings file sets, with their SLA clocks, replies
// from the support address, internal notes, satisfaction after closing and the reports. The HTTP layer (app.ts) and the
// mail servers (mailer.ts) are outside; everything here works on the database and the applied settings.
import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  configWarnings,
  email as checkEmail,
  PRIORITIES,
  type Address,
  type Channel,
  type Config,
  type ConfigFileState,
  type Priority,
  type Queue,
} from "./config.ts";
import {
  addressTicket,
  cleanSubject,
  HEADER,
  newMessageId,
  newPart,
  ourTickets,
  parseEmail,
  quote,
  replyAddress,
  replySubject,
  subjectTicket,
  type Attachment,
  type Inbound,
} from "./email.ts";
import { describeHours, localDate, wallClock, type Hours } from "./hours.ts";
import { crmDirectory, kbSuggester, type ArticleSuggester, type CrmCustomer, type CustomerDirectory, type SuggestedArticle } from "./links.ts";
import type { Cursor, OutgoingMail, Reader, Sender } from "./mailer.ts";
import { route, targetsFor } from "./routing.ts";
import { sanitizeEmail, textToHtml } from "./sanitize.ts";
import { clock, current, restart, retarget, settle, stop, type ClockRow, type ClockView } from "./sla.ts";
import { greeting, words } from "./words.ts";

export type ProblemCode =
  | "invalid-token"
  | "invalid-json"
  | "invalid-body"
  | "forbidden-origin"
  | "not-found"
  | "conflict"
  | "rate-limited"
  | "payload-too-large"
  | "unavailable"
  | "internal-error";

export class HdError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly retryAfter?: number;
  constructor(status: number, code: ProblemCode, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** Who does something: a signed-in person, an API token, or the tests' admin token. */
export interface Actor {
  id: string;
  name: string;
}

export type Status = "open" | "waiting" | "solved" | "closed";
export type Range = 7 | 30 | 90;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** One attachment, and all of one message's, that are kept. */
const MAX_ATTACHMENT = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 25 * 1024 * 1024;
/** A ticket that gets more customer messages than this in an hour is in a loop; the rest are not added. */
const MAX_PER_TICKET_HOUR = 30;
/** Waits between tries to send a reply: 1 min, 5 min, 15 min, 1 h, 3 h, then it failed. */
const RETRY = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR];

export function parseRange(v: string | null): Range {
  if (v === null || v === "") return 30;
  const n = Number(v);
  if (n !== 7 && n !== 30 && n !== 90) throw new HdError(422, "invalid-body", "days is 7, 30 or 90.");
  return n;
}

interface TicketRow extends ClockRow {
  number: number;
  subject: string;
  status: Status;
  priority: Priority;
  queue: string;
  channel: Channel;
  source: string;
  form: string | null;
  address: string | null;
  routed_by: string;
  customer_email: string | null;
  customer_name: string | null;
  plan: string | null;
  crm_id: string | null;
  language: string | null;
  external_id: string | null;
  owner_id: string | null;
  owner_name: string | null;
  created_at: string;
  updated_at: string;
  first_reply_at: string | null;
  solved_at: string | null;
  closed_at: string | null;
  csat_token: string | null;
  csat_asked_at: string | null;
  csat_score: number | null;
  csat_comment: string | null;
  csat_at: string | null;
  follows: number | null;
}

interface MessageRow {
  id: string;
  ticket: number;
  kind: "customer" | "agent" | "note" | "system";
  via: "email" | "form" | "chat" | "web" | "helpdesk";
  author_id: string | null;
  author_name: string;
  author_email: string | null;
  at: string;
  subject: string | null;
  body: string;
  full_text: string | null;
  html: string | null;
  message_id: string | null;
  to_addrs: string | null;
  cc_addrs: string | null;
  delivery: "queued" | "sent" | "failed" | null;
  delivery_error: string | null;
  attempts: number;
  next_attempt_at: string | null;
  event: string | null;
  data: string | null;
}

export interface SlaSummary {
  which: "firstReply" | "solution";
  state: ClockView["state"];
  remaining: number;
  dueAt: string | null;
  missedAt: string | null;
}

export interface TicketSummary {
  number: number;
  subject: string;
  status: Status;
  priority: Priority;
  queue: { id: string; name: string };
  channel: Channel;
  customer: { email: string | null; name: string | null };
  owner: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  sla: SlaSummary | null;
  satisfaction: number | null;
}

export interface MessageView {
  id: string;
  kind: MessageRow["kind"];
  via: MessageRow["via"];
  author: { id: string | null; name: string; email: string | null };
  at: string;
  subject: string | null;
  body: string;
  fullText: string | null;
  html: string | null;
  to: string[];
  cc: string[];
  delivery: MessageRow["delivery"];
  deliveryError: string | null;
  event: string | null;
  data: Record<string, unknown> | null;
  attachments: Array<{ id: string; filename: string; contentType: string; size: number }>;
}

export interface NewMessage {
  kind: MessageRow["kind"];
  via: MessageRow["via"];
  authorId?: string | null;
  authorName: string;
  authorEmail?: string | null;
  at?: number;
  subject?: string | null;
  body: string;
  fullText?: string | null;
  html?: string | null;
  messageId?: string | null;
  to?: string[];
  cc?: string[];
  delivery?: MessageRow["delivery"];
  nextAttemptAt?: number | null;
  event?: string;
  data?: Record<string, unknown>;
  attachments?: Attachment[];
}

export interface Options {
  publicUrl: string;
  clock?: () => number;
  env?: Record<string, string | undefined>;
  sender?: Sender;
  reader?: Reader;
  /** Stand-ins for CRM and Knowledge Base, for tests; by default they come from the file. */
  crm?: (config: Config) => CustomerDirectory | null;
  kb?: (config: Config) => ArticleSuggester | null;
  fileState?: () => ConfigFileState | null;
  log?: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

export const counters = {
  received: new Map<string, number>(),
  sent: new Map<string, number>(),
};
const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

export function createHelpdesk(db: DatabaseSync, opts: Options) {
  const now = opts.clock ?? Date.now;
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const iso = (ms = now()) => new Date(ms).toISOString();
  let cfg: Config | null = null;
  let yaml = "";
  let crm: CustomerDirectory | null = null;
  let kb: ArticleSuggester | null = null;
  const crmCache = new Map<string, { at: number; value: CrmCustomer | null }>();

  const q = <T>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: SQLInputValue[]) => db.prepare(sql).get(...p) as T | undefined;
  const run = (sql: string, ...p: SQLInputValue[]) => db.prepare(sql).run(...p);
  function tx<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function setting(key: string, make: () => string): string {
    const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
    if (row) return row.value;
    const value = make();
    run("INSERT INTO settings (key, value) VALUES (?, ?)", key, value);
    return value;
  }
  /** Signs reply addresses (support+1001-tag@): made once, kept in the database. */
  const replySecret = setting("reply_secret", () => randomBytes(32).toString("hex"));

  function config(): Config {
    if (!cfg) throw new HdError(503, "unavailable", "The settings file is not applied yet.");
    return cfg;
  }

  function setConfig(next: Config, text: string): string[] {
    cfg = next;
    yaml = text;
    crm = opts.crm ? opts.crm(next) : next.crm ? crmDirectory({ url: next.crm.url, token: env[next.crm.token] }) : null;
    kb = opts.kb ? opts.kb(next) : next.knowledgeBase ? kbSuggester({ url: next.knowledgeBase.url }) : null;
    crmCache.clear();
    opts.sender?.close();
    const warnings = configWarnings(next, env);
    // Tickets in a queue the file no longer has stay where they are; they are listed for the team to move.
    const gone = q<{ queue: string; n: number }>("SELECT queue, COUNT(*) AS n FROM tickets WHERE status IN ('open', 'waiting') GROUP BY queue").filter(
      (r) => !next.queues.some((x) => x.id === r.queue),
    );
    for (const g of gone) warnings.push(`${g.n} open tickets are in the queue ${g.queue}, which is no longer in the file; move them to another queue.`);
    return warnings;
  }

  const queueOf = (id: string): Queue => {
    const c = config();
    return c.queues.find((x) => x.id === id) ?? { ...c.queues.at(-1)!, id, name: id };
  };
  const hoursOf = (row: TicketRow): Hours => queueOf(row.queue).hours;
  const addressOf = (a: string | null): Address | null => (a ? (config().addresses.find((x) => x.address === a) ?? null) : null);
  const ticketRow = (n: number) => one<TicketRow>("SELECT * FROM tickets WHERE number = ?", n);
  function mustTicket(n: number): TicketRow {
    const row = Number.isInteger(n) ? ticketRow(n) : undefined;
    if (!row) throw new HdError(404, "not-found", `There is no ticket #${n}.`);
    return row;
  }

  function patch(n: number, fields: Record<string, SQLInputValue | undefined>) {
    const entries = Object.entries({ ...fields, updated_at: iso() }).filter(([, v]) => v !== undefined) as Array<[string, SQLInputValue]>;
    run(`UPDATE tickets SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE number = ?`, ...entries.map(([, v]) => v), n);
  }

  function addMessage(ticket: number, m: NewMessage): string {
    const id = randomUUID();
    run(
      `INSERT INTO messages (id, ticket, kind, via, author_id, author_name, author_email, at, subject, body, full_text, html, message_id, to_addrs, cc_addrs,
         delivery, next_attempt_at, event, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      ticket,
      m.kind,
      m.via,
      m.authorId ?? null,
      m.authorName.slice(0, 200),
      m.authorEmail ?? null,
      iso(m.at ?? now()),
      m.subject ?? null,
      m.body,
      m.fullText ?? null,
      m.html ?? null,
      m.messageId ?? null,
      m.to?.length ? JSON.stringify(m.to) : null,
      m.cc?.length ? JSON.stringify(m.cc) : null,
      m.delivery ?? null,
      m.nextAttemptAt ? iso(m.nextAttemptAt) : null,
      m.event ?? null,
      m.data ? JSON.stringify(m.data) : null,
    );
    let total = 0;
    for (const a of m.attachments ?? []) {
      if (a.size > MAX_ATTACHMENT || total + a.size > MAX_ATTACHMENTS) continue;
      total += a.size;
      run(
        "INSERT INTO attachments (id, message, filename, content_type, size, content_id, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
        randomUUID(),
        id,
        a.filename,
        a.contentType,
        a.size,
        a.contentId,
        a.data,
      );
    }
    return id;
  }

  const system = (ticket: number, event: string, body: string, data: Record<string, unknown> = {}) =>
    addMessage(ticket, { kind: "system", via: "helpdesk", authorName: "Helpdesk", body, event, data });

  const targetText = (ms: number | null, queue: Queue, which: "firstReply" | "solution", plan: string | null) => {
    if (ms === null) return null;
    const over = plan ? queue.slaByPlan[plan.toLowerCase()]?.[which] : undefined;
    return (over ?? queue.sla[which])?.text ?? null;
  };

  // ------------------------------------------------------------------ CRM and Knowledge Base

  /** The customer from CRM, kept five minutes. Throws when CRM cannot be asked; null when it knows no such address. */
  async function lookup(email: string): Promise<CrmCustomer | null> {
    if (!crm) return null;
    const hit = crmCache.get(email);
    if (hit && now() - hit.at < 5 * MINUTE) return hit.value;
    const value = await crm.lookup(email);
    if (crmCache.size > 2000) crmCache.clear();
    crmCache.set(email, { at: now(), value });
    return value;
  }

  // ------------------------------------------------------------------ opening a ticket

  interface Opening {
    channel: Channel;
    address: string | null;
    source: string;
    form: string | null;
    subject: string;
    customerEmail: string | null;
    customerName: string | null;
    language: string | null;
    externalId: string | null;
    follows: number | null;
    messages: NewMessage[];
    /** The customer's email that opened it, stored with its HTML sanitized. */
    email?: NewMessage;
    /** A chat that an agent in Live Chat already answered: its first reply is done. */
    answered?: boolean;
  }

  async function open(o: Opening): Promise<number> {
    const c = config();
    let plan: string | null = null;
    let crmId: string | null = null;
    let crmError: string | null = null;
    if (crm && o.customerEmail) {
      try {
        const customer = await lookup(o.customerEmail);
        plan = customer?.contact.plan?.id ?? null;
        crmId = customer?.contact.id ?? null;
      } catch (err) {
        crmError = (err as Error).message;
        log("warn", "CRM did not answer: the ticket is routed without the customer's plan", { error: crmError });
      }
    }
    const routed = route(c, {
      channel: o.channel,
      address: o.channel === "email" ? o.address : null,
      source: o.channel === "email" ? null : o.source,
      form: o.form,
      subject: o.subject,
      fromEmail: o.customerEmail,
      plan,
    });
    const at = now();
    const number = tx(() => {
      const r = run(
        `INSERT INTO tickets (subject, status, priority, queue, channel, source, form, address, routed_by, customer_email, customer_name, plan, crm_id, language,
           external_id, created_at, updated_at, fr_target, sol_target, run_since, follows)
         VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        o.subject,
        routed.queue.priority,
        routed.queue.id,
        o.channel,
        o.source,
        o.form,
        o.address,
        routed.rule,
        o.customerEmail,
        o.customerName,
        plan,
        crmId,
        o.language,
        o.externalId,
        iso(at),
        iso(at),
        routed.firstReply,
        routed.solution,
        iso(at),
        o.follows,
      );
      const n = Number(r.lastInsertRowid);
      const fr = targetText(routed.firstReply, routed.queue, "firstReply", plan);
      const sol = targetText(routed.solution, routed.queue, "solution", plan);
      const from = o.channel === "email" ? `an email to ${o.address}` : `${o.channel === "chat" ? "a chat" : "a form"} from ${o.source}`;
      system(
        n,
        "opened",
        `Opened from ${from}. Routed to ${routed.queue.name} by the rule ${routed.rule}${fr || sol ? `; SLA${fr ? ` first reply ${fr}` : ""}${fr && sol ? "," : ""}${sol ? ` solution ${sol}` : ""}` : ""}.`,
        { channel: o.channel, address: o.address, source: o.source, queue: routed.queue.name, rule: routed.rule, firstReply: fr, solution: sol, plan },
      );
      if (o.follows) system(n, "follows", `Follows #${o.follows}, which was closed.`, { ticket: o.follows });
      if (crmError) system(n, "crm-unavailable", "CRM did not answer, so the customer's plan was not used for routing.", { error: crmError });
      for (const m of o.messages) addMessage(n, m);
      if (o.email) addEmail(n, o.email);
      if (o.answered) patch(n, { ...stop(ticketRow(n)!, "firstReply", at), first_reply_at: iso(at) });
      return n;
    });
    count(counters.received, o.channel === "email" ? "ticket" : o.channel);
    log("info", "ticket opened", { ticket: number, channel: o.channel, queue: routed.queue.id, rule: routed.rule });
    if (c.support.acknowledge && o.channel !== "chat" && o.customerEmail) acknowledge(number);
    return number;
  }

  /** "We have your request", at most once an hour to one address, so two auto-responders cannot loop through it. */
  function acknowledge(number: number) {
    const t = ticketRow(number)!;
    const c = config();
    const address = addressOf(t.address);
    if (!address?.smtp || !t.customer_email) return;
    const recent = one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages m JOIN tickets t ON t.number = m.ticket WHERE m.event = 'acknowledged' AND t.customer_email = ? AND m.at > ?`,
      t.customer_email,
      iso(now() - HOUR),
    );
    if (recent && recent.n > 0) return;
    const w = words(c.support.language);
    const text = w("ackText", { name: (t.customer_name ?? "").split(/\s+/)[0] ?? "", number, support: address.name }).replace(/ ,/, ",");
    queueMail(t, {
      kind: "system",
      event: "acknowledged",
      subject: w("ackSubject", { number }),
      text,
      html: textToHtml(text),
      auto: "auto-replied",
      summary: `Told ${t.customer_email} the request is received.`,
    });
  }

  // ------------------------------------------------------------------ emails in

  type Ingested =
    | { action: "ticket" | "reply"; ticket: number }
    | { action: "duplicate" }
    | { action: "ignored"; reason: string; ticket?: number }
    | { action: "bounce"; tickets: number[] };

  function ignore(address: string, m: Partial<Inbound>, reason: string, ticket?: number): Ingested {
    run(
      "INSERT INTO ignored (at, address, sender, subject, reason) VALUES (?, ?, ?, ?, ?)",
      iso(),
      address,
      m.from?.email ?? null,
      (m.subject ?? "").slice(0, 300),
      reason,
    );
    count(counters.received, "ignored");
    log("info", "email not made a ticket", { address, reason, ticket });
    return { action: "ignored", reason, ...(ticket ? { ticket } : {}) };
  }

  /** The ticket an email belongs to: by the Message-IDs it answers, then our reply address, then [#number] from its customer. */
  function thread(m: Inbound): TicketRow | null {
    const refs = [...m.inReplyTo, ...[...m.references].reverse()];
    if (refs.length) {
      const hit = one<{ ticket: number }>(
        `SELECT ticket FROM messages WHERE message_id IN (${refs.map(() => "?").join(",")}) ORDER BY at DESC LIMIT 1`,
        ...refs.map((r) => r.toLowerCase()),
      );
      const n = hit?.ticket ?? ourTickets(refs)[0];
      const row = n ? ticketRow(n) : undefined;
      if (row) return row;
    }
    const ours = config().addresses.map((a) => a.address);
    const byAddress = addressTicket(m.recipients, ours, replySecret);
    if (byAddress) {
      const row = ticketRow(byAddress);
      if (row) return row;
    }
    const bySubject = subjectTicket(m.subject);
    if (bySubject && m.from) {
      const row = ticketRow(bySubject);
      // A number in a subject is easy to write, so it threads only email from someone already in the ticket.
      const known =
        row &&
        (row.customer_email === m.from.email ||
          !!one("SELECT 1 FROM messages WHERE ticket = ? AND (author_email = ? OR cc_addrs LIKE ?)", row.number, m.from.email, `%"${m.from.email}"%`));
      if (row && known) return row;
    }
    return null;
  }

  function customerMessage(m: Inbound, via: "email"): NewMessage {
    const text = m.text.trim();
    const body = newPart(text);
    return {
      kind: "customer",
      via,
      authorName: m.from?.name || m.from?.email || "Unknown sender",
      authorEmail: m.from?.email ?? null,
      at: Math.min(m.date ?? now(), now()),
      subject: m.subject,
      body: body.slice(0, 200_000) || "(no text)",
      fullText: body !== text ? text.slice(0, 500_000) : null,
      html: m.html ? m.html : null,
      messageId: m.messageId?.toLowerCase() ?? null,
      to: m.recipients.slice(0, 50),
      cc: m.cc.slice(0, 50),
      attachments: m.attachments,
    };
  }

  /** Adds a customer's email to a ticket, with its HTML sanitized and inline images pointed at their attachments. */
  function addEmail(ticket: number, nm: NewMessage) {
    const rawHtml = nm.html;
    const id = addMessage(ticket, { ...nm, html: null });
    if (rawHtml) {
      const inline: Record<string, string> = {};
      for (const a of q<{ id: string; content_id: string | null }>("SELECT id, content_id FROM attachments WHERE message = ?", id))
        if (a.content_id) inline[a.content_id] = `/api/v1/attachments/${a.id}`;
      const html = sanitizeEmail(rawHtml.slice(0, 2_000_000), inline);
      if (html) run("UPDATE messages SET html = ? WHERE id = ?", html, id);
    }
    return id;
  }

  /** What one email read from a support address becomes. */
  async function ingestEmail(address: Address, raw: Buffer | string): Promise<Ingested> {
    const c = config();
    let m: Inbound;
    try {
      m = await parseEmail(raw);
    } catch (err) {
      return ignore(address.address, {}, `could not be read: ${(err as Error).message}`);
    }
    if (m.messageId && one("SELECT 1 FROM messages WHERE message_id = ?", m.messageId.toLowerCase())) {
      count(counters.received, "duplicate");
      return { action: "duplicate" };
    }
    const ours = c.addresses.map((a) => a.address);
    if (m.bounce) {
      const tickets = ourTickets([...m.bounce.ours, ...m.inReplyTo, ...m.references]).filter((n) => ticketRow(n));
      for (const n of tickets) {
        const failed = m.bounce.ours.find((id) => one("SELECT 1 FROM messages WHERE message_id = ? AND ticket = ?", id, n));
        if (failed) run("UPDATE messages SET delivery = 'failed', delivery_error = ? WHERE message_id = ?", "The receiving mail server sent it back.", failed);
        system(n, "bounce", `An email to ${m.bounce.recipients.join(", ") || "the customer"} could not be delivered: ${m.subject}`, {
          recipients: m.bounce.recipients,
          subject: m.subject,
        });
      }
      ignore(address.address, m, "a bounce", tickets[0]);
      return { action: "bounce", tickets };
    }
    if (m.ours) return ignore(address.address, m, "sent by Helpdesk itself");
    if (m.from && ours.includes(m.from.email)) return ignore(address.address, m, "sent from a support address");
    if (!m.from) return ignore(address.address, m, "no sender");
    const t = thread(m);
    if (m.auto) {
      // An out-of-office to a reply is worth knowing; it changes nothing on the ticket.
      if (t) system(t.number, "auto-reply", `Automatic reply from ${m.from.email}: ${m.subject}`, { from: m.from.email, subject: m.subject, reason: m.auto });
      return ignore(address.address, m, `automatic: ${m.auto}`, t?.number);
    }
    const message = customerMessage(m, "email");
    if (t) {
      const closed = t.status === "closed" || (t.status === "solved" && t.solved_at && now() - Date.parse(t.solved_at) > c.support.reopenWithin);
      if (!closed) {
        const recent = one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE ticket = ? AND kind = 'customer' AND at > ?", t.number, iso(now() - HOUR))!;
        if (recent.n >= MAX_PER_TICKET_HOUR) return ignore(address.address, m, "more than 30 emails to one ticket in an hour", t.number);
        tx(() => {
          addEmail(t.number, message);
          customerAnswered(t);
        });
        count(counters.received, "reply");
        return { action: "reply", ticket: t.number };
      }
    }
    const sender = m.from.email;
    const recent = one<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE customer_email = ? AND created_at > ?", sender, iso(now() - HOUR))!;
    if (recent.n >= c.support.maxNewPerHour) return ignore(address.address, m, `more than ${c.support.maxNewPerHour} new tickets from ${sender} in an hour`);
    // A mailbox that gets mail for several of the addresses routes by the one the email was sent to.
    const to = ours.find((a) => m.recipients.includes(a)) ?? address.address;
    const number = await open({
      channel: "email",
      address: to,
      source: to,
      form: null,
      subject: cleanSubject(m.subject),
      customerEmail: sender,
      customerName: m.from.name || null,
      language: null,
      externalId: null,
      follows: t?.number ?? null,
      messages: [],
      email: message,
    });
    return { action: "ticket", ticket: number };
  }

  /** The customer wrote: a waiting ticket is open again, a solved one is reopened, and the clocks run. */
  function customerAnswered(t: TicketRow) {
    const fresh = ticketRow(t.number)!;
    const hours = hoursOf(fresh);
    if (fresh.status === "solved") {
      patch(t.number, { ...restart("solution"), ...settle(fresh, hours, now(), "run"), status: "open", solved_at: null });
      system(t.number, "reopened", "Reopened: the customer answered after it was solved.");
    } else if (fresh.status === "waiting") {
      patch(t.number, { ...settle(fresh, hours, now(), "run"), status: "open" });
    } else patch(t.number, {});
  }

  // ------------------------------------------------------------------ forms and chats in

  const SOURCE_FIELDS = ["source", "form", "email", "name", "subject", "message", "fields", "language", "external_id", "transcript", "website", "redirect"];

  /**
   * A ticket from Forms, Live Chat or a site's own form. `trusted` is true when the request carried the source's key
   * (a server); a browser's post is checked against the source's origins before this is called.
   */
  async function intake(sourceId: string, body: unknown, trusted: boolean): Promise<{ ticket: TicketSummary; created: boolean }> {
    const c = config();
    const source = c.sources.find((s) => s.id === sourceId);
    if (!source) throw new HdError(404, "not-found", `There is no source ${sourceId} in the settings file.`);
    if (!isObj(body)) throw new HdError(422, "invalid-body", "The body is an object.");
    const extra = Object.keys(body).filter((k) => !SOURCE_FIELDS.includes(k));
    if (extra.length) throw new HdError(422, "invalid-body", `Unknown ${extra.join(", ")}.`);
    const str = (k: string, max: number, required = false): string | null => {
      const v = body[k];
      if (v === undefined || v === null || v === "") {
        if (required) throw new HdError(422, "invalid-body", `${k} is required.`);
        return null;
      }
      if (typeof v !== "string" || v.length > max) throw new HdError(422, "invalid-body", `${k} is a text of up to ${max} characters.`);
      return v.trim() || null;
    };
    const rawEmail = str("email", 254, source.channel === "form");
    let customerEmail: string | null = null;
    if (rawEmail) {
      try {
        customerEmail = checkEmail(rawEmail, "email");
      } catch {
        throw new HdError(422, "invalid-body", "email is not an email address.");
      }
    }
    const name = str("name", 200);
    const message = str("message", 50_000, source.channel === "form" && !Array.isArray(body.transcript));
    const subject = str("subject", 300) ?? (message ?? "").split("\n")[0]!.slice(0, 120) ?? "";
    const form = str("form", 64);
    const language = str("language", 10);
    const externalId = str("external_id", 200);
    const fields: Record<string, string> = {};
    if (body.fields !== undefined) {
      if (!isObj(body.fields) || Object.keys(body.fields).length > 50) throw new HdError(422, "invalid-body", "fields is an object of up to 50 answers.");
      for (const [k, v] of Object.entries(body.fields)) {
        if (k.length > 100 || !["string", "number", "boolean"].includes(typeof v) || String(v).length > 5000)
          throw new HdError(422, "invalid-body", "fields holds texts, numbers or true and false, each up to 5000 characters.");
        fields[k] = String(v);
      }
    }
    const transcript: NewMessage[] = [];
    if (body.transcript !== undefined) {
      if (!Array.isArray(body.transcript) || body.transcript.length > 500) throw new HdError(422, "invalid-body", "transcript is a list of up to 500 lines.");
      for (const [i, line] of body.transcript.entries()) {
        if (
          !isObj(line) ||
          (line.from !== "customer" && line.from !== "agent") ||
          typeof line.text !== "string" ||
          !line.text.trim() ||
          line.text.length > 10_000
        )
          throw new HdError(422, "invalid-body", `transcript[${i}] is { from: customer or agent, name, at, text }.`);
        const at = typeof line.at === "string" && !Number.isNaN(Date.parse(line.at)) ? Math.min(Date.parse(line.at), now()) : now();
        const who =
          typeof line.name === "string" && line.name.trim() ? line.name.trim().slice(0, 200) : line.from === "customer" ? (name ?? "Visitor") : "Agent";
        transcript.push({
          kind: line.from,
          via: "chat",
          authorName: who,
          authorEmail: line.from === "customer" ? customerEmail : null,
          at,
          body: line.text.trim(),
        });
      }
    }
    const title =
      subject ||
      transcript
        .find((m) => m.kind === "customer")
        ?.body.split("\n")[0]!
        .slice(0, 120) ||
      "";
    if (!message && !transcript.length) throw new HdError(422, "invalid-body", "message or transcript is required.");
    if (!trusted && transcript.some((m) => m.kind === "agent"))
      throw new HdError(422, "invalid-body", "Only a server with the source's key sends agents' lines.");
    if (!trusted && externalId === null && customerEmail) {
      const recent = one<{ n: number }>("SELECT COUNT(*) AS n FROM tickets WHERE customer_email = ? AND created_at > ?", customerEmail, iso(now() - HOUR))!;
      if (recent.n >= c.support.maxNewPerHour) throw new HdError(429, "rate-limited", "Too many requests from this address; try again in an hour.", 3600);
    }
    if (externalId) {
      const existing = one<{ number: number }>("SELECT number FROM tickets WHERE source = ? AND external_id = ?", source.id, externalId);
      if (existing) return { ticket: summary(ticketRow(existing.number)!), created: false };
    }
    const messages: NewMessage[] = [];
    if (message)
      messages.push({
        kind: "customer",
        via: source.channel,
        authorName: name ?? customerEmail ?? "Visitor",
        authorEmail: customerEmail,
        subject,
        body: message,
        ...(Object.keys(fields).length ? { data: { fields } } : {}),
      });
    messages.push(...transcript);
    const number = await open({
      channel: source.channel,
      address: source.address,
      source: source.id,
      form,
      subject: title || "(no subject)",
      customerEmail,
      customerName: name,
      language,
      externalId,
      follows: null,
      messages,
      answered: transcript.some((m) => m.kind === "agent"),
    });
    return { ticket: summary(ticketRow(number)!), created: true };
  }

  /** More of a chat or a form's conversation, from the source that opened the ticket. */
  function intakeMessage(sourceId: string, number: number, body: unknown) {
    const t = mustTicket(number);
    if (t.source !== sourceId) throw new HdError(404, "not-found", `There is no ticket #${number} from ${sourceId}.`);
    if (!isObj(body)) throw new HdError(422, "invalid-body", "The body is an object.");
    const from = body.from ?? "customer";
    if ((from !== "customer" && from !== "agent") || typeof body.text !== "string" || !body.text.trim() || body.text.length > 50_000)
      throw new HdError(422, "invalid-body", "The body is { from: customer or agent, name, text }.");
    const name =
      typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : from === "customer" ? (t.customer_name ?? "Visitor") : "Agent";
    const source = config().sources.find((s) => s.id === sourceId);
    tx(() => {
      addMessage(number, {
        kind: from,
        via: source?.channel ?? "chat",
        authorName: name,
        authorEmail: from === "customer" ? t.customer_email : null,
        body: body.text as string,
      });
      if (from === "customer") customerAnswered(t);
      else if (!t.fr_done_at) {
        const fresh = ticketRow(number)!;
        const settled = settle(fresh, hoursOf(fresh), now(), fresh.status === "open" ? "run" : "pause");
        patch(number, { ...settled, ...stop({ ...fresh, ...settled }, "firstReply", now()), first_reply_at: iso() });
      }
    });
    return summary(ticketRow(number)!);
  }

  // ------------------------------------------------------------------ emails out

  interface Outgoing {
    kind: "agent" | "system";
    event?: string;
    actor?: Actor;
    subject: string;
    text: string;
    html: string;
    /** Auto-Submitted for what Helpdesk sends on its own (RFC 3834), so the other side's auto-responder stays quiet. */
    auto?: "auto-replied" | "auto-generated";
    /** The body kept in the thread; the reply's own text, without the quote. */
    summary: string;
    attachments?: Attachment[];
    cc?: string[];
  }

  /** Puts an email to the ticket's customer in the outbox and returns its message id; deliver() sends it. */
  function queueMail(t: TicketRow, o: Outgoing): string {
    const c = config();
    const address = addressOf(t.address)!;
    const refs = q<{ message_id: string }>("SELECT message_id FROM messages WHERE ticket = ? AND message_id IS NOT NULL ORDER BY at", t.number).map(
      (r) => r.message_id,
    );
    const lastCustomer = one<{ message_id: string | null }>(
      "SELECT message_id FROM messages WHERE ticket = ? AND kind = 'customer' AND message_id IS NOT NULL ORDER BY at DESC LIMIT 1",
      t.number,
    );
    const messageId = newMessageId(t.number, address.address);
    const data = {
      subject: o.subject,
      text: o.text,
      html: o.html,
      inReplyTo: lastCustomer?.message_id ?? refs.at(-1) ?? null,
      // The first and the last ones: enough for any mail app to thread, and a header that stays short.
      references: refs.length > 20 ? [refs[0]!, ...refs.slice(-19)] : refs,
      replyTo: c.mail.replyToken !== "subject" ? replyAddress(address.address, t.number, replySecret) : null,
      auto: o.auto ?? null,
    };
    return addMessage(t.number, {
      kind: o.kind,
      via: "email",
      authorId: o.actor?.id ?? null,
      authorName: o.actor?.name ?? "Helpdesk",
      authorEmail: address.address,
      subject: o.subject,
      body: o.summary,
      messageId,
      to: [t.customer_email!],
      cc: o.cc,
      delivery: "queued",
      nextAttemptAt: now(),
      event: o.event,
      data: { outgoing: data },
      attachments: o.attachments,
    });
  }

  /** Sends one queued email; on failure it is tried again later, and fails for good after the last try. */
  async function deliver(id: string): Promise<boolean> {
    const m = one<MessageRow>("SELECT * FROM messages WHERE id = ? AND delivery = 'queued'", id);
    if (!m || !opts.sender) return false;
    const t = ticketRow(m.ticket)!;
    const address = addressOf(t.address);
    const out = (JSON.parse(m.data ?? "{}") as { outgoing?: Record<string, unknown> }).outgoing ?? {};
    const attempts = m.attempts + 1;
    try {
      if (!address) throw new Error(`${t.address ?? "The ticket's address"} is not in the settings file any more.`);
      const mail: OutgoingMail = {
        from: { name: address.name, address: address.address },
        to: JSON.parse(m.to_addrs ?? "[]") as string[],
        cc: JSON.parse(m.cc_addrs ?? "[]") as string[],
        ...(out.replyTo ? { replyTo: out.replyTo as string } : {}),
        subject: out.subject as string,
        text: out.text as string,
        html: out.html as string,
        messageId: m.message_id!,
        ...(out.inReplyTo ? { inReplyTo: out.inReplyTo as string } : {}),
        references: (out.references as string[]) ?? [],
        headers: {
          [HEADER]: String(t.number),
          ...(out.auto ? { "Auto-Submitted": out.auto as string, "X-Auto-Response-Suppress": "All", Precedence: "auto_reply" } : {}),
        },
        attachments: q<{ filename: string; content_type: string; data: Uint8Array }>(
          "SELECT filename, content_type, data FROM attachments WHERE message = ?",
          id,
        ).map((a) => ({ filename: a.filename, contentType: a.content_type, content: Buffer.from(a.data) })),
      };
      await opts.sender.send(address, env[address.password], mail);
      run("UPDATE messages SET delivery = 'sent', delivery_error = NULL, attempts = ?, next_attempt_at = NULL WHERE id = ?", attempts, id);
      count(counters.sent, "sent");
      return true;
    } catch (err) {
      const error = (err as Error).message.slice(0, 500);
      const last = attempts > RETRY.length;
      run(
        "UPDATE messages SET delivery = ?, delivery_error = ?, attempts = ?, next_attempt_at = ? WHERE id = ?",
        last ? "failed" : "queued",
        error,
        attempts,
        last ? null : iso(now() + RETRY[attempts - 1]!),
        id,
      );
      count(counters.sent, last ? "failed" : "retry");
      log(last ? "error" : "warn", last ? "email could not be sent" : "email not sent yet: will try again", { ticket: t.number, error, attempts });
      if (last) system(t.number, "delivery-failed", `An email to ${t.customer_email} could not be sent: ${error}`, { error });
      return false;
    }
  }

  // ------------------------------------------------------------------ the team's work on a ticket

  const team = () => {
    try {
      return q<{ id: string; name: string; email: string }>("SELECT id, name, email FROM auth_users WHERE status != 'disabled' ORDER BY name COLLATE NOCASE");
    } catch {
      return [];
    }
  };

  function attachmentsIn(v: unknown): Attachment[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 10) throw new HdError(422, "invalid-body", "attachments is a list of up to 10 files.");
    let total = 0;
    return v.map((a, i) => {
      if (!isObj(a) || typeof a.name !== "string" || !a.name.trim() || a.name.length > 200 || typeof a.data !== "string")
        throw new HdError(422, "invalid-body", `attachments[${i}] is { name, type, data } with data in base64.`);
      const data = Buffer.from(a.data, "base64");
      total += data.length;
      if (data.length > MAX_ATTACHMENT || total > MAX_ATTACHMENTS)
        throw new HdError(413, "payload-too-large", "Attachments are up to 15 MiB each and 25 MiB together.");
      const type = typeof a.type === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(a.type) ? a.type : "application/octet-stream";
      return { filename: a.name.replace(/[\\/\r\n]/g, "_"), contentType: type, size: data.length, contentId: null, data };
    });
  }

  /** A reply to the customer from the ticket's support address. The ticket then waits on the customer. */
  async function reply(who: Actor, number: number, body: unknown) {
    const t = mustTicket(number);
    if (!isObj(body) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 100_000)
      throw new HdError(422, "invalid-body", "text is the reply, up to 100000 characters.");
    const then = body.status ?? "waiting";
    if (then !== "waiting" && then !== "open" && then !== "solved") throw new HdError(422, "invalid-body", "status is waiting, open or solved.");
    const cc = body.cc === undefined ? [] : Array.isArray(body.cc) ? body.cc : null;
    if (!cc || cc.length > 10) throw new HdError(422, "invalid-body", "cc is a list of up to 10 addresses.");
    const ccs = cc.map((x) => {
      try {
        return checkEmail(x, "cc");
      } catch {
        throw new HdError(422, "invalid-body", "cc holds email addresses.");
      }
    });
    if (!t.customer_email) throw new HdError(409, "conflict", "This ticket has no customer email to reply to.");
    const address = addressOf(t.address);
    if (!address) throw new HdError(409, "conflict", "This ticket has no support address to reply from; add one to the settings file.");
    if (!address.smtp || !opts.sender)
      throw new HdError(409, "conflict", `${address.address} has no SMTP server in the settings file, so replies cannot be sent.`);
    const attachments = attachmentsIn(body.attachments);
    const text = body.text.trim();
    const c = config();
    const last = one<MessageRow>("SELECT * FROM messages WHERE ticket = ? AND kind = 'customer' ORDER BY at DESC LIMIT 1", number);
    const quoted = last
      ? quote(last.body, last.author_email ? `${last.author_name} <${last.author_email}>` : last.author_name, new Date(last.at), c.support.language)
      : "";
    const subject = replySubject(last?.subject || t.subject, number, c.mail.replyToken !== "address");
    const id = tx(() => {
      const id = queueMail(t, {
        kind: "agent",
        actor: who,
        subject,
        text: quoted ? `${text}\n\n${quoted}` : text,
        html: `${textToHtml(text)}${
          quoted
            ? `\n<blockquote type="cite">${textToHtml(
                quoted
                  .split("\n")
                  .slice(1)
                  .map((l) => l.replace(/^> ?/, ""))
                  .join("\n"),
              )}</blockquote>`
            : ""
        }`,
        summary: text,
        attachments,
        cc: ccs,
      });
      afterReply(who, number, then);
      return id;
    });
    await deliver(id);
    return message(id);
  }

  /** What a reply does to the ticket: the first-reply clock stops, an owner is set, and the status moves on. */
  function afterReply(who: Actor, number: number, then: "waiting" | "open" | "solved") {
    const t = ticketRow(number)!;
    const hours = hoursOf(t);
    const at = now();
    const settled = settle(t, hours, at, then === "open" ? "run" : "pause");
    const merged = { ...t, ...settled };
    const fields: Record<string, SQLInputValue> = { ...settled, ...stop(merged, "firstReply", at), status: then };
    if (!t.first_reply_at) fields.first_reply_at = iso(at);
    if (!t.owner_id && isPerson(who)) Object.assign(fields, { owner_id: who.id, owner_name: who.name });
    if (then === "solved") Object.assign(fields, solving(merged, at));
    patch(number, fields);
    if (then === "solved") system(number, "solved", `Solved by ${who.name}.`, { by: who.name });
  }

  const isPerson = (who: Actor) => !who.id.startsWith("token:") && who.id !== "admin-token";

  function solving(t: TicketRow, at: number): Record<string, SQLInputValue> {
    return {
      ...stop(t, "firstReply", at),
      ...stop(t, "solution", at),
      solved_at: iso(at),
      run_since: null,
      csat_token: t.csat_token ?? randomBytes(18).toString("base64url"),
    };
  }

  function note(who: Actor, number: number, body: unknown) {
    mustTicket(number);
    if (!isObj(body) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 100_000)
      throw new HdError(422, "invalid-body", "text is the note, up to 100000 characters.");
    const id = tx(() => {
      const id = addMessage(number, { kind: "note", via: "web", authorId: who.id, authorName: who.name, body: body.text as string });
      patch(number, {});
      return id;
    });
    return message(id);
  }

  /** Changes a ticket's owner, priority, queue or status. */
  function update(who: Actor, number: number, body: unknown) {
    const t = mustTicket(number);
    if (!isObj(body)) throw new HdError(422, "invalid-body", "The body is an object.");
    const extra = Object.keys(body).filter((k) => !["owner", "priority", "queue", "status"].includes(k));
    if (extra.length) throw new HdError(422, "invalid-body", `Unknown ${extra.join(", ")}; it takes owner, priority, queue and status.`);
    const c = config();
    if (body.priority !== undefined && !(PRIORITIES as readonly string[]).includes(body.priority as string))
      throw new HdError(422, "invalid-body", `priority is ${PRIORITIES.join(", ")}.`);
    if (body.queue !== undefined && !c.queues.some((x) => x.id === body.queue))
      throw new HdError(422, "invalid-body", "queue is one of the queues in the settings file.");
    if (body.status !== undefined && !["open", "waiting", "solved"].includes(body.status as string))
      throw new HdError(422, "invalid-body", "status is open, waiting or solved.");
    let owner: { id: string; name: string } | null | undefined;
    if (body.owner !== undefined) {
      if (body.owner === null) owner = null;
      else {
        const m = team().find((p) => p.id === body.owner);
        if (!m) throw new HdError(422, "invalid-body", "owner is the id of a member, or null.");
        owner = { id: m.id, name: m.name };
      }
    }
    tx(() => {
      const at = now();
      if (owner !== undefined && owner?.id !== t.owner_id) {
        patch(number, { owner_id: owner?.id ?? null, owner_name: owner?.name ?? null });
        system(number, "assigned", owner ? `Assigned to ${owner.name} by ${who.name}.` : `Unassigned by ${who.name}.`, {
          to: owner?.name ?? null,
          by: who.name,
        });
      }
      if (body.priority !== undefined && body.priority !== t.priority) {
        patch(number, { priority: body.priority as string });
        system(number, "priority", `Priority ${t.priority} to ${body.priority as string}, by ${who.name}.`, {
          from: t.priority,
          to: body.priority,
          by: who.name,
        });
      }
      if (body.queue !== undefined && body.queue !== t.queue) {
        const row = ticketRow(number)!;
        const running = row.run_since !== null;
        const settled = settle(row, hoursOf(row), at, running ? "run" : "pause");
        const to = c.queues.find((x) => x.id === body.queue)!;
        patch(number, { ...settled, ...retarget({ ...row, ...settled }, targetsFor(to, row.plan)), queue: to.id });
        system(
          number,
          "moved",
          `Moved from ${queueOf(row.queue).name} to ${to.name} by ${who.name}; the clocks not met or missed start again with ${to.name}'s SLA.`,
          {
            from: queueOf(row.queue).name,
            to: to.name,
            by: who.name,
          },
        );
      }
      if (body.status !== undefined) setStatus(who, number, body.status as "open" | "waiting" | "solved", at);
    });
    return detail(number);
  }

  function setStatus(who: Actor, number: number, to: "open" | "waiting" | "solved", at: number) {
    const t = ticketRow(number)!;
    const from = t.status === "closed" ? "solved" : t.status;
    if (from === to) return;
    const hours = hoursOf(t);
    if (to === "solved") {
      const settled = settle(t, hours, at, "pause");
      patch(number, { ...settled, ...solving({ ...t, ...settled }, at), status: "solved" });
      system(number, "solved", `Solved by ${who.name}.`, { by: who.name });
    } else if (from === "solved") {
      patch(number, { ...restart("solution"), ...settle(t, hours, at, to === "open" ? "run" : "pause"), status: to, solved_at: null, closed_at: null });
      system(number, "reopened", `Reopened by ${who.name}.`, { by: who.name });
    } else {
      patch(number, { ...settle(t, hours, at, to === "open" ? "run" : "pause"), status: to });
      system(number, "status", to === "waiting" ? `Waiting on the customer, set by ${who.name}.` : `Open again, set by ${who.name}.`, { to, by: who.name });
    }
  }

  /** Gives tickets to one member (or to nobody). `owner` may be "me". */
  function assign(who: Actor, body: unknown) {
    if (!isObj(body) || !Array.isArray(body.tickets) || !body.tickets.length || body.tickets.length > 500 || body.tickets.some((n) => !Number.isInteger(n)))
      throw new HdError(422, "invalid-body", "tickets is a list of ticket numbers.");
    const ownerId = body.owner === "me" ? who.id : body.owner;
    if (body.owner === "me" && !isPerson(who)) throw new HdError(422, "invalid-body", "An API token is not a member; name one.");
    for (const n of body.tickets as number[]) mustTicket(n);
    const changed = (body.tickets as number[]).filter((n) => ticketRow(n)!.owner_id !== ownerId);
    for (const n of changed) update(who, n, { owner: ownerId ?? null });
    return { assigned: changed.length };
  }

  // ------------------------------------------------------------------ reading

  function slaOf(t: TicketRow, at = now()): SlaSummary | null {
    if (t.status === "solved" || t.status === "closed") return null;
    const c = current(t, hoursOf(t), at);
    return c ? { which: c.which, state: c.state, remaining: c.remaining, dueAt: c.dueAt, missedAt: c.missedAt } : null;
  }

  function summary(t: TicketRow): TicketSummary {
    return {
      number: t.number,
      subject: t.subject,
      status: t.status,
      priority: t.priority,
      queue: { id: t.queue, name: queueOf(t.queue).name },
      channel: t.channel,
      customer: { email: t.customer_email, name: t.customer_name },
      owner: t.owner_id ? { id: t.owner_id, name: t.owner_name ?? t.owner_id } : null,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      sla: slaOf(t),
      satisfaction: t.csat_score,
    };
  }

  /** Tickets by queue, status and words, the SLA that runs out first first. */
  function list(url: URLSearchParams): TicketSummary[] {
    const where: string[] = [];
    const p: SQLInputValue[] = [];
    const status = url.get("status");
    if (status) {
      if (!["open", "waiting", "solved"].includes(status)) throw new HdError(422, "invalid-body", "status is open, waiting or solved.");
      where.push(status === "solved" ? "status IN ('solved', 'closed')" : "status = ?");
      if (status !== "solved") p.push(status);
    }
    const queue = url.get("queue");
    if (queue) (where.push("queue = ?"), p.push(queue));
    const owner = url.get("owner");
    if (owner === "none") where.push("owner_id IS NULL");
    else if (owner) (where.push("owner_id = ?"), p.push(owner));
    const words = (url.get("q") ?? "").trim().slice(0, 200);
    if (words) {
      const n = /^#?(\d{1,12})$/.exec(words);
      if (n) (where.push("number = ?"), p.push(Number(n[1])));
      else {
        where.push("(subject LIKE ? ESCAPE '\\' OR customer_email LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\')");
        const like = `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        p.push(like, like, like);
      }
    }
    const limit = Math.min(1000, Math.max(1, Number(url.get("limit") ?? 500) || 500));
    const rows = q<TicketRow>(
      `SELECT * FROM tickets ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`,
      ...p,
      limit,
    );
    const at = now();
    const out = rows.map((r) => ({ ...summary(r), sla: slaOf(r, at) }));
    const key = (t: TicketSummary) => (t.sla ? (t.sla.state === "paused" ? Number.MAX_SAFE_INTEGER - 1 : t.sla.remaining) : Number.MAX_SAFE_INTEGER);
    return out.sort((a, b) => key(a) - key(b));
  }

  function message(id: string): MessageView {
    const m = one<MessageRow>("SELECT * FROM messages WHERE id = ?", id)!;
    return messageView(m, attachmentsOf([id]));
  }

  function attachmentsOf(ids: string[]) {
    const out = new Map<string, MessageView["attachments"]>();
    if (!ids.length) return out;
    for (const a of q<{ id: string; message: string; filename: string; content_type: string; size: number; content_id: string | null }>(
      `SELECT id, message, filename, content_type, size, content_id FROM attachments WHERE message IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    ))
      out.set(a.message, [...(out.get(a.message) ?? []), { id: a.id, filename: a.filename, contentType: a.content_type, size: a.size }]);
    return out;
  }

  function messageView(m: MessageRow, attachments: Map<string, MessageView["attachments"]>): MessageView {
    const data = m.data ? (JSON.parse(m.data) as Record<string, unknown>) : null;
    if (data) delete data.outgoing;
    return {
      id: m.id,
      kind: m.kind,
      via: m.via,
      author: { id: m.author_id, name: m.author_name, email: m.author_email },
      at: m.at,
      subject: m.subject,
      body: m.body,
      fullText: m.full_text,
      html: m.html,
      to: m.to_addrs ? (JSON.parse(m.to_addrs) as string[]) : [],
      cc: m.cc_addrs ? (JSON.parse(m.cc_addrs) as string[]) : [],
      delivery: m.delivery,
      deliveryError: m.delivery_error,
      event: m.event,
      data: data && Object.keys(data).length ? data : null,
      attachments: attachments.get(m.id) ?? [],
    };
  }

  function fill(text: string, t: TicketRow, who: string | null) {
    const name = t.customer_name ?? "";
    return text.replace(/\{(name|first_name|number|agent|queue)\}/g, (_, k: string) =>
      k === "name"
        ? name
        : k === "first_name"
          ? (name.split(/\s+/)[0] ?? "")
          : k === "number"
            ? String(t.number)
            : k === "agent"
              ? (who ?? "")
              : queueOf(t.queue).name,
    );
  }

  function detail(number: number, who?: Actor) {
    const t = mustTicket(number);
    const at = now();
    const hours = hoursOf(t);
    const queue = queueOf(t.queue);
    const rows = q<MessageRow>("SELECT * FROM messages WHERE ticket = ? ORDER BY at, rowid", number);
    const att = attachmentsOf(rows.map((r) => r.id));
    const address = addressOf(t.address);
    const c = config();
    return {
      ...summary(t),
      address: t.address,
      canReply: !!t.customer_email && !!address?.smtp && !!opts.sender,
      source: t.source,
      form: t.form,
      routedBy: t.routed_by,
      plan: t.plan,
      follows: t.follows,
      firstReplyAt: t.first_reply_at,
      solvedAt: t.solved_at,
      clocks: {
        firstReply: clock(t, "firstReply", hours, at),
        solution: clock(t, "solution", hours, at),
        firstReplyText: targetText(t.fr_target, queue, "firstReply", t.plan),
        solutionText: targetText(t.sol_target, queue, "solution", t.plan),
      },
      hours: { always: hours.always, text: queue.hoursText, timeZone: hours.timeZone, described: describeHours(hours) },
      rating: t.csat_asked_at || t.csat_score ? { askedAt: t.csat_asked_at, score: t.csat_score, comment: t.csat_comment, at: t.csat_at } : null,
      messages: rows.map((r) => messageView(r, att)),
      answers: c.answers
        .filter((a) => !a.queues.length || a.queues.includes(t.queue))
        .map((a) => ({ id: a.id, title: a.title, text: fill(a.text, t, who?.name ?? null) })),
    };
  }

  function attachment(id: string) {
    const a = one<{ filename: string; content_type: string; data: Uint8Array }>("SELECT filename, content_type, data FROM attachments WHERE id = ?", id);
    if (!a) throw new HdError(404, "not-found", "There is no such attachment.");
    return { filename: a.filename, contentType: a.content_type, data: Buffer.from(a.data) };
  }

  async function customer(number: number) {
    const t = mustTicket(number);
    if (!crm) return { linked: false };
    const year = `${new Date(now()).getUTCFullYear()}-01-01`;
    const tickets = t.customer_email
      ? one<{ year: number; open: number }>(
          "SELECT SUM(created_at >= ?) AS year, SUM(status IN ('open', 'waiting')) AS open FROM tickets WHERE customer_email = ?",
          year,
          t.customer_email,
        )!
      : { year: 0, open: 0 };
    const base = { linked: true, email: t.customer_email, tickets: { year: tickets.year ?? 0, open: tickets.open ?? 0 } };
    if (!t.customer_email) return { ...base, found: false, error: null, contact: null, deals: [] };
    try {
      const c = await lookup(t.customer_email);
      return { ...base, found: !!c, error: null, contact: c?.contact ?? null, deals: c?.deals ?? [] };
    } catch (err) {
      return { ...base, found: false, error: (err as Error).message, contact: null, deals: [] };
    }
  }

  async function articles(number: number): Promise<{ linked: boolean; articles: SuggestedArticle[]; error: string | null }> {
    const t = mustTicket(number);
    if (!kb) return { linked: false, articles: [], error: null };
    try {
      return { linked: true, articles: await kb.suggest(t.subject, config().knowledgeBase?.language ?? t.language), error: null };
    } catch (err) {
      return { linked: true, articles: [], error: (err as Error).message };
    }
  }

  // ------------------------------------------------------------------ satisfaction

  function ticketByToken(token: string) {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
    return one<TicketRow>("SELECT * FROM tickets WHERE csat_token = ?", token) ?? null;
  }

  /** The answer to "how did we do?", which can be changed for 30 days after it was asked. */
  function rate(token: string, score: number, comment: string | null): TicketRow {
    const t = ticketByToken(token);
    if (!t || !t.csat_asked_at || now() - Date.parse(t.csat_asked_at) > 30 * DAY) throw new HdError(404, "not-found", "This link has ended.");
    if (!Number.isInteger(score) || score < 1 || score > 5) throw new HdError(422, "invalid-body", "score is 1 to 5.");
    tx(() => {
      run("UPDATE tickets SET csat_score = ?, csat_comment = ?, csat_at = ? WHERE number = ?", score, comment?.slice(0, 5000) || null, iso(), t.number);
      system(t.number, "satisfaction", `The customer answered ${score} of 5.${comment ? ` "${comment.slice(0, 200)}"` : ""}`, { score, comment });
    });
    return ticketRow(t.number)!;
  }

  function askSatisfaction(t: TicketRow) {
    const c = config();
    const address = addressOf(t.address);
    const at = iso();
    run("UPDATE tickets SET csat_asked_at = ? WHERE number = ?", at, t.number);
    if (!address?.smtp || !t.customer_email || !t.csat_token) return;
    const w = words(c.support.language);
    const url = (s: number) => `${opts.publicUrl}/r/${t.csat_token}?score=${s}`;
    const scores = [5, 4, 3, 2, 1] as const;
    const links = scores.map((s) => `${s} ${w(`score${s}`)}: ${url(s)}`).join("\n");
    const text = w("askText", {
      name: (t.customer_name ?? "").split(/\s+/)[0] ?? "",
      number: t.number,
      subject: t.subject,
      links,
      support: address.name,
    }).replace(/ ,/, ",");
    const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
    const html = `<p>${esc(greeting(c.support.language, t.customer_name))}</p>
<p>${esc(w("askLead", { number: t.number, subject: t.subject }))}</p>
<p>${scores.map((s) => `<a href="${esc(url(s))}">${s} ${esc(w(`score${s}`))}</a>`).join(" &middot; ")}</p>
<p>${esc(w("thanksSign"))}<br>${esc(address.name)}</p>`;
    queueMail(t, {
      kind: "system",
      event: "satisfaction-asked",
      subject: w("askSubject", { number: t.number }),
      text,
      html,
      auto: "auto-generated",
      summary: `Asked ${t.customer_email} how it went.`,
    });
  }

  // ------------------------------------------------------------------ in the background

  let checking = false;
  const lastCheck = new Map<string, number>();

  /** Reads each address's new mail, when its turn has come (mail.check_every), or every address now with `force`. */
  async function checkMail(force = false): Promise<void> {
    if (checking || !opts.reader || !cfg) return;
    checking = true;
    try {
      for (const a of cfg.addresses.filter((x) => x.imap)) {
        if (!force && now() - (lastCheck.get(a.address) ?? 0) < cfg.mail.checkEvery) continue;
        lastCheck.set(a.address, now());
        const box = one<{ uid_validity: string | null; last_uid: number; folder: string }>(
          "SELECT uid_validity, last_uid, folder FROM mailboxes WHERE address = ?",
          a.address,
        );
        const cursor: Cursor = box && box.folder === a.folder ? { uidValidity: box.uid_validity, lastUid: box.last_uid } : { uidValidity: null, lastUid: 0 };
        const save = (c: Cursor, error: string | null) =>
          run(
            `INSERT INTO mailboxes (address, folder, uid_validity, last_uid, checked_at, ok_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (address) DO UPDATE SET folder = excluded.folder, uid_validity = excluded.uid_validity, last_uid = excluded.last_uid,
               checked_at = excluded.checked_at, ok_at = COALESCE(excluded.ok_at, mailboxes.ok_at), error = excluded.error`,
            a.address,
            a.folder,
            c.uidValidity,
            c.lastUid,
            iso(),
            error ? null : iso(),
            error,
          );
        try {
          const next = await opts.reader.read(a, env[a.password], cursor, async (raw) => void (await ingestEmail(a, raw)));
          save(next, null);
        } catch (err) {
          const e = err as Error & { cursor?: Cursor };
          save(e.cursor ?? cursor, e.message.slice(0, 500));
          log("warn", "mail could not be read", { address: a.address, error: e.message });
        }
      }
    } finally {
      checking = false;
    }
  }

  let ticking = false;
  /** Sends what is due in the outbox, asks for satisfaction, and closes solved tickets after the reopen window. */
  async function tick(): Promise<void> {
    if (ticking || !cfg) return;
    ticking = true;
    try {
      const c = cfg;
      for (const m of q<{ id: string }>("SELECT id FROM messages WHERE delivery = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50", iso()))
        await deliver(m.id);
      if (c.satisfaction.askAfter !== null)
        for (const t of q<TicketRow>(
          "SELECT * FROM tickets WHERE status IN ('solved', 'closed') AND csat_asked_at IS NULL AND solved_at <= ? AND solved_at > ? LIMIT 100",
          iso(now() - c.satisfaction.askAfter),
          iso(now() - c.satisfaction.askAfter - 7 * DAY),
        )) {
          askSatisfaction(t);
        }
      for (const m of q<{ id: string }>("SELECT id FROM messages WHERE delivery = 'queued' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 50", iso()))
        await deliver(m.id);
      run("UPDATE tickets SET status = 'closed', closed_at = ? WHERE status = 'solved' AND solved_at <= ?", iso(), iso(now() - c.support.reopenWithin));
    } finally {
      ticking = false;
    }
  }

  function purge() {
    run("DELETE FROM ignored WHERE at < ?", iso(now() - 30 * DAY));
  }

  // ------------------------------------------------------------------ overview and reports

  function mail() {
    const c = config();
    const boxes = q<{ address: string; checked_at: string | null; ok_at: string | null; error: string | null }>(
      "SELECT address, checked_at, ok_at, error FROM mailboxes",
    );
    const ignored = q<{ address: string; n: number }>("SELECT address, COUNT(*) AS n FROM ignored WHERE at > ? GROUP BY address", iso(now() - 7 * DAY));
    const queued = one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE delivery = 'queued'")!.n;
    const failed = one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE delivery = 'failed' AND at > ?", iso(now() - 7 * DAY))!.n;
    return {
      addresses: c.addresses.map((a) => {
        const b = boxes.find((x) => x.address === a.address);
        return {
          address: a.address,
          name: a.name,
          reading: !!a.imap,
          sending: !!a.smtp,
          passwordSet: !!env[a.password],
          checkedAt: b?.checked_at ?? null,
          okAt: b?.ok_at ?? null,
          error: b?.error ?? null,
          ignored: ignored.find((x) => x.address === a.address)?.n ?? 0,
        };
      }),
      outbox: { queued, failed },
      ignored: q<{ at: string; address: string; sender: string | null; subject: string | null; reason: string }>(
        "SELECT at, address, sender, subject, reason FROM ignored ORDER BY at DESC LIMIT 20",
      ),
    };
  }

  function overview() {
    const c = config();
    const at = now();
    const live = q<TicketRow>("SELECT * FROM tickets WHERE status IN ('open', 'waiting')");
    const views = live.map((t) => ({ t, s: summary(t) }));
    const atRisk = views
      .filter(({ s }) => s.status === "open" && s.sla && (s.sla.state === "missed" || (s.sla.state === "running" && s.sla.remaining < HOUR)))
      .map(({ s }) => s)
      .sort((a, b) => a.sla!.remaining - b.sla!.remaining)
      .slice(0, 20);
    return {
      file: opts.fileState?.() ?? null,
      open: views.filter(({ s }) => s.status === "open").length,
      waiting: views.filter(({ s }) => s.status === "waiting").length,
      unassigned: views.filter(({ s }) => s.status === "open" && !s.owner).length,
      missedNow: views.filter(({ s }) => s.sla?.state === "missed").length,
      queues: c.queues.map((x) => ({
        id: x.id,
        name: x.name,
        open: views.filter(({ s }) => s.status === "open" && s.queue.id === x.id).length,
        waiting: views.filter(({ s }) => s.status === "waiting" && s.queue.id === x.id).length,
      })),
      atRisk,
      at: iso(at),
    };
  }

  function report(days: Range) {
    const c = config();
    const at = now();
    const tz = c.support.timeZone;
    const from = at - days * DAY;
    const before = from - days * DAY;
    const created = q<TicketRow>("SELECT * FROM tickets WHERE created_at >= ?", iso(before));
    const solvedRows = q<TicketRow>("SELECT * FROM tickets WHERE solved_at >= ?", iso(before));
    const inRange = (s: string | null, a = from, b = at) => !!s && Date.parse(s) >= a && Date.parse(s) <= b;
    const opened = created.filter((t) => inRange(t.created_at));
    const firstReplies = (a: number, b: number) => created.filter((t) => t.fr_done_at && inRange(t.first_reply_at, a, b)).map((t) => t.fr_elapsed);
    const solveTimes = (rows: TicketRow[]) => rows.filter((t) => t.sol_done_at && inRange(t.solved_at)).map((t) => t.sol_elapsed);
    /** Met and missed: each clock that stopped in time is met; each that passed its target is missed. */
    const sla = (rows: TicketRow[]) => {
      let met = 0;
      let missed = 0;
      for (const t of rows)
        for (const p of ["fr", "sol"] as const) {
          if (t[`${p}_target`] === null) continue;
          if (t[`${p}_breached_at`] || (!t[`${p}_done_at`] && clock(t, p === "fr" ? "firstReply" : "solution", hoursOf(t), at)?.state === "missed")) missed++;
          else if (t[`${p}_done_at`]) met++;
        }
      return { met, missed };
    };
    const csat = (rows: TicketRow[]) => {
      const scores = rows.filter((t) => t.csat_score !== null && inRange(t.csat_at)).map((t) => t.csat_score!);
      return { avg: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null, count: scores.length };
    };
    const all = q<TicketRow>("SELECT * FROM tickets WHERE csat_at >= ?", iso(from));
    const slaAll = sla(opened);

    const dayKey = (ms: number) => {
      const d = localDate(ms, tz);
      return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
    };
    const series = Array.from({ length: days }, (_, i) => dayKey(at - (days - 1 - i) * DAY)).map((day) => ({
      day,
      opened: opened.filter((t) => dayKey(Date.parse(t.created_at)) === day).length,
      solved: solvedRows.filter((t) => inRange(t.solved_at) && dayKey(Date.parse(t.solved_at!)) === day).length,
    }));
    // When tickets arrive: the average a week, by weekday and hour, in the support's time zone.
    const heat = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    for (const t of opened) {
      const ms = Date.parse(t.created_at);
      heat[localDate(ms, tz).weekday]![wallClock(ms, tz).hour]! += 1;
    }
    const weeks = days / 7;
    return {
      days,
      from: iso(from),
      timeZone: tz,
      totals: {
        opened: opened.length,
        openedBefore: created.filter((t) => inRange(t.created_at, before, from)).length,
        solved: solvedRows.filter((t) => inRange(t.solved_at)).length,
        firstReply: median(firstReplies(from, at)),
        firstReplyBefore: median(firstReplies(before, from)),
        solvedIn: median(solveTimes(solvedRows)),
        slaMet: slaAll.met,
        slaMissed: slaAll.missed,
        satisfaction: csat(all).avg,
        answers: csat(all).count,
      },
      series,
      byQueue: c.queues.map((x) => {
        const rows = opened.filter((t) => t.queue === x.id);
        const s = sla(rows);
        const cs = csat(all.filter((t) => t.queue === x.id));
        return {
          id: x.id,
          name: x.name,
          tickets: rows.length,
          firstReply: median(rows.filter((t) => t.fr_done_at).map((t) => t.fr_elapsed)),
          solvedIn: median(solveTimes(solvedRows.filter((t) => t.queue === x.id))),
          slaMet: s.met,
          slaMissed: s.missed,
          satisfaction: cs.avg,
          answers: cs.count,
        };
      }),
      byChannel: (["email", "form", "chat"] as const).map((ch) => ({ channel: ch, tickets: opened.filter((t) => t.channel === ch).length })),
      arrivals: heat.map((row) => row.map((n) => Math.round((n / weeks) * 10) / 10)),
    };
  }

  function gauges() {
    const by = q<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM tickets GROUP BY status");
    const live = q<TicketRow>("SELECT * FROM tickets WHERE status IN ('open', 'waiting')");
    const at = now();
    return {
      tickets: Object.fromEntries(by.map((r) => [r.status, r.n])) as Record<string, number>,
      missed: cfg ? live.filter((t) => slaOf(t, at)?.state === "missed").length : 0,
      outbox: one<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE delivery = 'queued'")!.n,
      mailboxErrors: one<{ n: number }>("SELECT COUNT(*) AS n FROM mailboxes WHERE error IS NOT NULL")!.n,
    };
  }

  function settingsView() {
    const c = cfg;
    return {
      config: c && {
        support: c.support,
        mail: c.mail,
        addresses: c.addresses,
        queues: c.queues.map((x) => ({ ...x, hours: { ...x.hours, described: describeHours(x.hours) } })),
        satisfaction: c.satisfaction,
        answers: c.answers,
        sources: c.sources,
        crm: c.crm,
        knowledgeBase: c.knowledgeBase,
      },
      yaml,
      file: opts.fileState?.() ?? null,
    };
  }

  return {
    setConfig,
    config: () => cfg,
    settings: settingsView,
    team,
    ingestEmail,
    intake,
    intakeMessage,
    reply,
    note,
    update,
    assign,
    list,
    detail,
    attachment,
    customer,
    articles,
    rate,
    ticketByToken,
    checkMail,
    tick,
    deliver,
    purge,
    overview,
    report,
    mail,
    gauges,
    now,
  };
}

export type Helpdesk = ReturnType<typeof createHelpdesk>;
