// Helpdesk's settings, from one YAML file (HELPDESK_CONFIG): the support addresses and their mail servers, the queues
// with their routing rules, working hours and SLAs, satisfaction, saved answers, the sources Forms and Live Chat post
// tickets from, and the links to CRM and Knowledge Base. As in the other products, the file is the only way in: no
// screen or API route changes these. It is applied whole or not at all, read again within a minute of a change, and a
// file with a mistake leaves the last good version in place. Tickets themselves are kept in the database.
//
// Secrets are never in the file: it names the environment variables that hold them.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parse } from "yaml";
import { dayLength, parseHours, validTimeZone, type Hours } from "./hours.ts";

export const CHANNELS = ["email", "form", "chat"] as const;
export type Channel = (typeof CHANNELS)[number];
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const LANGUAGES = ["en", "de", "tr"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface MailServer {
  host: string;
  port: number;
  /** true: TLS from the start (993, 465). false: STARTTLS, which is then required. */
  tls: boolean;
}

export interface Address {
  address: string;
  /** The name replies are sent with. */
  name: string;
  /** The IMAP and SMTP login; the address itself unless the file says otherwise. */
  user: string;
  /** The environment variable holding the password; never the password itself. */
  password: string;
  /** The folder new mail is read from. */
  folder: string;
  /** null: mail to this address is not read (replies may still go out). */
  imap: MailServer | null;
  /** null: no replies can be sent from this address. */
  smtp: MailServer | null;
}

export interface Target {
  /** Working time, in ms: days count as the queue's working day. */
  ms: number;
  /** As written in the file, such as 4h or 1d. */
  text: string;
}

export interface SlaTargets {
  firstReply: Target | null;
  solution: Target | null;
}

/** One rule: every condition given must hold; a list of values holds when any of them does. */
export interface Condition {
  address?: string[];
  channel?: Channel[];
  form?: string[];
  source?: string[];
  subjectHas?: string[];
  fromDomain?: string[];
  plan?: string[];
}

export interface Queue {
  id: string;
  name: string;
  /** null catches every ticket. Otherwise a ticket matches when any of the rules does. */
  match: Condition[] | null;
  hours: Hours;
  /** The hours as written, such as weekdays 09:00-18:00. */
  hoursText: string;
  sla: SlaTargets;
  /** Targets for customers on a plan, by plan id, over the queue's own. */
  slaByPlan: Record<string, Partial<SlaTargets>>;
  /** The priority a new ticket in the queue starts with. */
  priority: Priority;
}

export interface Answer {
  id: string;
  title: string;
  /** May use {name}, {first_name}, {number}, {agent} and {queue}. */
  text: string;
  /** Offered in these queues only; [] is every queue. */
  queues: string[];
}

export interface Source {
  id: string;
  name: string;
  channel: "form" | "chat";
  /** The environment variable holding the key servers send as a Bearer token; null for browser posts only. */
  key: string | null;
  /** Origins whose pages may post a ticket with no key, from the customer's browser. */
  origins: string[];
  /** The support address replies to these tickets are sent from; null when there is none. */
  address: string | null;
}

export interface Config {
  support: {
    name: string;
    /** The language of the emails Helpdesk writes itself: acknowledgements and the satisfaction question. */
    language: Language;
    timeZone: string;
    holidays: string[];
    /** A customer's reply this long after a ticket is solved opens a new ticket instead of reopening it. */
    reopenWithin: number;
    /** Send "we have your request" to new tickets from email and forms. */
    acknowledge: boolean;
    /** More new tickets than this from one sender in an hour are not opened: a loop or a flood. */
    maxNewPerHour: number;
  };
  mail: {
    checkEvery: number;
    /** Where a reply carries its ticket, besides the Message-ID headers. */
    replyToken: "subject" | "address" | "both";
  };
  addresses: Address[];
  queues: Queue[];
  satisfaction: { askAfter: number | null };
  answers: Answer[];
  sources: Source[];
  crm: { url: string; token: string } | null;
  knowledgeBase: { url: string; language: string | null } | null;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const ENV = /^[A-Z][A-Z0-9_]{0,63}$/;
const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOP = ["support", "mail", "addresses", "queues", "satisfaction", "answers", "sources", "crm", "knowledge_base"];
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function keys(v: Record<string, unknown>, at: string, allowed: string[]) {
  const extra = Object.keys(v).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${at}: unknown ${extra.join(", ")}; it takes ${allowed.join(", ")}.`);
}

function text(v: unknown, at: string, max = 80): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${at} is a text of 1 to ${max} characters.`);
  return v.trim();
}

function env(v: unknown, at: string): string {
  if (typeof v !== "string" || !ENV.test(v))
    throw new Error(`${at} is the name of an environment variable, such as HELPDESK_MAIL_PASSWORD, never the secret itself.`);
  return v;
}

function bool(v: unknown, at: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new Error(`${at} is true or false.`);
  return v;
}

export function email(v: unknown, at: string): string {
  if (typeof v !== "string" || !EMAIL.test(v.trim()) || v.length > 254) throw new Error(`${at} is an email address, such as support@example.com.`);
  return v.trim().toLowerCase();
}

function list(v: unknown, at: string, max = 100): unknown[] {
  if (v === undefined || v === null) return [];
  const items = Array.isArray(v) ? v : [v];
  if (items.length > max) throw new Error(`${at} holds at most ${max} entries.`);
  return items;
}

function origin(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  const local = url && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || (url.pathname !== "/" && url.pathname !== "") || url.search)
    throw new Error(`${at} is an origin with https://, such as https://www.example.com (http:// only for localhost).`);
  return url.origin;
}

function baseUrl(raw: unknown, at: string): string {
  const url = typeof raw === "string" ? URL.parse(raw.trim()) : null;
  // http:// stays inside the install: localhost, or a service name on the same network, such as crm.
  const local = url && (url.hostname === "127.0.0.1" || !url.hostname.includes("."));
  if (!url || (url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.search || url.hash)
    throw new Error(`${at} is an https:// address, such as https://crm.example.com (http:// only for a host without dots, such as http://crm:8080).`);
  return url.href.replace(/\/$/, "");
}

/** Reads 30m, 4h, 1d, 1d 4h or 2h30m into days and minutes. */
export function parseDuration(v: unknown, at: string): { days: number; minutes: number; text: string } {
  const s = typeof v === "number" ? `${v}m` : typeof v === "string" ? v.trim().toLowerCase() : "";
  const m = /^(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/.exec(s);
  if (!s || !m || (!m[1] && !m[2] && !m[3])) throw new Error(`${at} is a duration such as 30m, 4h, 1d or 1d 4h.`);
  const days = Number(m[1] ?? 0);
  const minutes = Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  if (days + minutes / 1440 > 3650 || days + minutes === 0) throw new Error(`${at} is more than nothing and at most ten years.`);
  return { days, minutes, text: s.replace(/\s+/g, " ") };
}

/** A calendar duration in ms: days are 24 hours. */
function calendar(v: unknown, at: string): number {
  const d = parseDuration(v, at);
  return (d.days * 1440 + d.minutes) * 60_000;
}

function server(v: unknown, at: string, kind: "imap" | "smtp"): MailServer | null {
  if (v === undefined || v === null || v === false) return null;
  let host: unknown;
  let port: unknown;
  let tls: unknown;
  if (typeof v === "string") {
    const m = /^([a-z0-9.-]+)(?::(\d+))?$/i.exec(v.trim());
    if (!m) throw new Error(`${at} is a host such as mail.example.com, host:port, or { host, port, tls }.`);
    host = m[1];
    port = m[2] ? Number(m[2]) : undefined;
  } else if (isObj(v)) {
    keys(v, at, ["host", "port", "tls"]);
    ({ host, port, tls } = v);
  } else throw new Error(`${at} is a host such as mail.example.com, host:port, or { host, port, tls }.`);
  if (typeof host !== "string" || !/^[a-z0-9.-]{1,253}$/i.test(host)) throw new Error(`${at}.host is a host name, such as mail.example.com.`);
  const secure = bool(tls, `${at}.tls`, port === undefined ? true : kind === "imap" ? port !== 143 : port !== 587 && port !== 25);
  const p = port ?? (kind === "imap" ? (secure ? 993 : 143) : secure ? 465 : 587);
  if (!Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535) throw new Error(`${at}.port is a port from 1 to 65535.`);
  return { host: host.toLowerCase(), port: p as number, tls: secure };
}

function strings(v: unknown, at: string, check: (s: string, at: string) => string = (s, a) => text(s, a, 200)): string[] {
  return [...new Set(list(v, at).map((x, i) => check(typeof x === "number" ? String(x) : (x as string), `${at}[${i}]`)))];
}

const MATCH = ["address", "channel", "form", "source", "subject_has", "from_domain", "plan"];

function condition(v: unknown, at: string, addresses: string[]): Condition {
  if (!isObj(v) || !Object.keys(v).length) throw new Error(`${at} is a map of ${MATCH.join(", ")}.`);
  keys(v, at, MATCH);
  const c: Condition = {};
  if (v.address !== undefined)
    c.address = strings(v.address, `${at}.address`, (s, a) => {
      const e = email(s, a);
      if (!addresses.includes(e)) throw new Error(`${a}: ${e} is not one of the addresses.`);
      return e;
    });
  if (v.channel !== undefined)
    c.channel = strings(v.channel, `${at}.channel`, (s, a) => {
      if (!(CHANNELS as readonly string[]).includes(s)) throw new Error(`${a} is ${CHANNELS.join(", ")}.`);
      return s;
    }) as Channel[];
  if (v.form !== undefined) c.form = strings(v.form, `${at}.form`, (s, a) => text(s, a, 64));
  if (v.source !== undefined) c.source = strings(v.source, `${at}.source`, (s, a) => text(s, a, 32));
  if (v.subject_has !== undefined) c.subjectHas = strings(v.subject_has, `${at}.subject_has`, (s, a) => fold(text(s, a, 80)));
  if (v.from_domain !== undefined)
    c.fromDomain = strings(v.from_domain, `${at}.from_domain`, (s, a) => {
      if (typeof s !== "string" || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.trim())) throw new Error(`${a} is a domain, such as example.com.`);
      return s.trim().toLowerCase();
    });
  if (v.plan !== undefined) c.plan = strings(v.plan, `${at}.plan`, (s, a) => text(s, a, 64).toLowerCase());
  return c;
}

/** Lowercase, without accents and with the Turkish dotless i folded, so `fatura` finds `FATURA` and `Fatura`. */
export function fold(s: string): string {
  return s.toLocaleLowerCase("tr").replace(/ı/g, "i").normalize("NFD").replace(/\p{M}/gu, "");
}

function targets(v: unknown, at: string, hours: Hours, partial: boolean): Partial<SlaTargets> {
  if (!isObj(v)) throw new Error(`${at} is a map with first_reply and solution, such as { first_reply: 4h, solution: 1d }.`);
  keys(v, at, ["first_reply", "solution"]);
  const day = dayLength(hours);
  const one = (x: unknown, a: string): Target | null => {
    if (x === null || x === "off") return null;
    const d = parseDuration(x, a);
    return { ms: d.days * day + d.minutes * 60_000, text: d.text };
  };
  const out: Partial<SlaTargets> = {};
  if (v.first_reply !== undefined) out.firstReply = one(v.first_reply, `${at}.first_reply`);
  else if (!partial) out.firstReply = null;
  if (v.solution !== undefined) out.solution = one(v.solution, `${at}.solution`);
  else if (!partial) out.solution = null;
  return out;
}

const titleCase = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replace(/-/g, " ");

/** Reads the file's text. Throws with the field at fault, so one message says what to fix. */
export function parseConfig(raw: string): Config {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObj(doc)) throw new Error(`The file is a map of ${TOP.join(", ")}.`);
  keys(doc, "The file", TOP);

  // ------------------------------------------------------------ support
  const s = doc.support ?? {};
  if (!isObj(s)) throw new Error("support is a map with name, language, time_zone, holidays, reopen_within, acknowledge and max_new_per_hour.");
  keys(s, "support", ["name", "language", "time_zone", "holidays", "reopen_within", "acknowledge", "max_new_per_hour"]);
  const supportName = s.name === undefined ? "Support" : text(s.name, "support.name");
  const language = (s.language ?? "en") as Language;
  if (!(LANGUAGES as readonly string[]).includes(language)) throw new Error(`support.language is ${LANGUAGES.join(", ")}.`);
  const timeZone = s.time_zone === undefined ? "UTC" : text(s.time_zone, "support.time_zone", 64);
  if (!validTimeZone(timeZone)) throw new Error(`support.time_zone: ${timeZone} is not a time zone, such as Europe/Istanbul.`);
  const holidays = strings(s.holidays, "support.holidays", (x, a) => {
    if (typeof x !== "string" || !DATE.test(x) || Number.isNaN(Date.parse(x))) throw new Error(`${a} is a date such as 2026-10-29.`);
    return x;
  });
  const reopenWithin = s.reopen_within === undefined ? 7 * 86_400_000 : calendar(s.reopen_within, "support.reopen_within");
  const maxNewPerHour = s.max_new_per_hour ?? 10;
  if (!Number.isInteger(maxNewPerHour) || (maxNewPerHour as number) < 1 || (maxNewPerHour as number) > 10_000)
    throw new Error("support.max_new_per_hour is a number from 1 to 10000.");

  // ------------------------------------------------------------ mail and addresses
  const m = doc.mail ?? {};
  if (!isObj(m)) throw new Error("mail is a map with imap, smtp, user, password, check_every and reply_token.");
  keys(m, "mail", ["imap", "smtp", "user", "password", "check_every", "reply_token"]);
  const imap = server(m.imap, "mail.imap", "imap");
  const smtp = server(m.smtp, "mail.smtp", "smtp");
  const defaultPassword = m.password === undefined ? "HELPDESK_MAIL_PASSWORD" : env(m.password, "mail.password");
  const defaultUser = m.user === undefined ? null : text(m.user, "mail.user", 254);
  const checkEvery = m.check_every === undefined ? 60_000 : calendar(m.check_every, "mail.check_every");
  if (checkEvery < 10_000 || checkEvery > 3_600_000) throw new Error("mail.check_every is from 10s to 1h, such as 1m.");
  const replyToken = (m.reply_token ?? "subject") as Config["mail"]["replyToken"];
  if (!["subject", "address", "both"].includes(replyToken)) throw new Error("mail.reply_token is subject, address or both.");

  const addresses: Address[] = [];
  list(doc.addresses, "addresses", 50).forEach((a, i) => {
    const at = `addresses[${i}]`;
    let entry: Address;
    if (typeof a === "string") {
      const address = email(a, at);
      entry = { address, name: supportName, user: defaultUser ?? address, password: defaultPassword, folder: "INBOX", imap, smtp };
    } else {
      if (!isObj(a)) throw new Error(`${at} is an email address, or a map with address, name, user, password, folder, imap and smtp.`);
      keys(a, at, ["address", "name", "user", "password", "folder", "imap", "smtp"]);
      const address = email(a.address, `${at}.address`);
      entry = {
        address,
        name: a.name === undefined ? supportName : text(a.name, `${at}.name`),
        user: a.user === undefined ? (defaultUser ?? address) : text(a.user, `${at}.user`, 254),
        password: a.password === undefined ? defaultPassword : env(a.password, `${at}.password`),
        folder: a.folder === undefined ? "INBOX" : text(a.folder, `${at}.folder`, 200),
        imap: a.imap === undefined ? imap : server(a.imap, `${at}.imap`, "imap"),
        smtp: a.smtp === undefined ? smtp : server(a.smtp, `${at}.smtp`, "smtp"),
      };
    }
    if (addresses.some((x) => x.address === entry.address)) throw new Error(`${at}: ${entry.address} is in the file twice.`);
    addresses.push(entry);
  });
  const addressList = addresses.map((a) => a.address);

  // ------------------------------------------------------------ queues
  const queues: Queue[] = [];
  const rawQueues = doc.queues ?? { general: { name: "General" } };
  if (!isObj(rawQueues) || !Object.keys(rawQueues).length)
    throw new Error("queues is a map of queue id to { name, match, hours, sla }, such as billing: { sla: { first_reply: 4h } }.");
  if (Object.keys(rawQueues).length > 100) throw new Error("queues holds at most 100 queues.");
  for (const [id, v] of Object.entries(rawQueues)) {
    const at = `queues.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: a queue id is up to 32 lowercase letters, digits and -, starting with a letter.`);
    const q = v ?? {};
    if (!isObj(q)) throw new Error(`${at} is a map with name, match, hours, time_zone, sla, sla_by_plan and priority.`);
    keys(q, at, ["name", "match", "hours", "time_zone", "sla", "sla_by_plan", "priority"]);
    const tz = q.time_zone === undefined ? timeZone : text(q.time_zone, `${at}.time_zone`, 64);
    if (!validTimeZone(tz)) throw new Error(`${at}.time_zone: ${tz} is not a time zone, such as Europe/Istanbul.`);
    const hoursText = q.hours === undefined ? "always" : text(q.hours, `${at}.hours`, 200);
    const days = parseHours(hoursText, `${at}.hours`);
    const hours: Hours = { always: days === null, days: days ?? [[], [], [], [], [], [], []], timeZone: tz, holidays };
    let match: Condition[] | null = null;
    if (q.match !== undefined && q.match !== null && q.match !== "all") {
      const rules = Array.isArray(q.match) ? q.match : [q.match];
      if (!rules.length || rules.length > 50) throw new Error(`${at}.match is a rule or a list of up to 50 rules.`);
      match = rules.map((r, i) => condition(r, Array.isArray(q.match) ? `${at}.match[${i}]` : `${at}.match`, addressList));
    }
    const sla = q.sla === undefined ? { firstReply: null, solution: null } : (targets(q.sla, `${at}.sla`, hours, false) as SlaTargets);
    const slaByPlan: Record<string, Partial<SlaTargets>> = {};
    if (q.sla_by_plan !== undefined) {
      if (!isObj(q.sla_by_plan)) throw new Error(`${at}.sla_by_plan is a map of plan id to targets, such as business: { first_reply: 2h }.`);
      for (const [plan, t] of Object.entries(q.sla_by_plan)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(plan)) throw new Error(`${at}.sla_by_plan: ${plan} is not a plan id.`);
        slaByPlan[plan.toLowerCase()] = targets(t, `${at}.sla_by_plan.${plan}`, hours, true);
      }
    }
    const priority = (q.priority ?? "normal") as Priority;
    if (!(PRIORITIES as readonly string[]).includes(priority)) throw new Error(`${at}.priority is ${PRIORITIES.join(", ")}.`);
    queues.push({ id, name: q.name === undefined ? titleCase(id) : text(q.name, `${at}.name`), match, hours, hoursText, sla, slaByPlan, priority });
  }

  // ------------------------------------------------------------ satisfaction
  const sat = doc.satisfaction ?? {};
  if (!isObj(sat)) throw new Error("satisfaction is a map with ask_after_solved.");
  keys(sat, "satisfaction", ["ask_after_solved"]);
  const askAfter =
    sat.ask_after_solved === false || sat.ask_after_solved === "off"
      ? null
      : sat.ask_after_solved === undefined
        ? 3_600_000
        : calendar(sat.ask_after_solved, "satisfaction.ask_after_solved");

  // ------------------------------------------------------------ saved answers
  const answers: Answer[] = [];
  list(doc.answers, "answers", 500).forEach((a, i) => {
    const at = `answers[${i}]`;
    if (!isObj(a)) throw new Error(`${at} is a map with id, title, text and queues.`);
    keys(a, at, ["id", "title", "text", "queues"]);
    const id = typeof a.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(a.id) ? a.id : null;
    if (!id) throw new Error(`${at}.id is up to 64 lowercase letters, digits and -.`);
    if (answers.some((x) => x.id === id)) throw new Error(`${at}: the id ${id} is in the file twice.`);
    const qs = strings(a.queues, `${at}.queues`, (x, at2) => {
      if (!queues.some((q) => q.id === x)) throw new Error(`${at2}: ${x} is not one of the queues.`);
      return x;
    });
    answers.push({ id, title: text(a.title, `${at}.title`, 120), text: text(a.text, `${at}.text`, 10_000), queues: qs });
  });

  // ------------------------------------------------------------ sources: Forms, Live Chat, a site's own form
  const sources: Source[] = [];
  const rawSources = doc.sources ?? {};
  if (!isObj(rawSources)) throw new Error("sources is a map of source id to { channel, key, origins, address }.");
  for (const [id, v] of Object.entries(rawSources)) {
    const at = `sources.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: a source id is up to 32 lowercase letters, digits and -, starting with a letter.`);
    if (!isObj(v)) throw new Error(`${at} is a map with name, channel, key, origins and address.`);
    keys(v, at, ["name", "channel", "key", "origins", "address"]);
    const channel = v.channel ?? (id.includes("chat") ? "chat" : "form");
    if (channel !== "form" && channel !== "chat") throw new Error(`${at}.channel is form or chat.`);
    const key = v.key === undefined || v.key === null ? null : env(v.key, `${at}.key`);
    const origins = strings(v.origins, `${at}.origins`, (x, a) => origin(x, a));
    if (!key && !origins.length) throw new Error(`${at} needs a key (servers) or origins (pages), or both.`);
    let address: string | null = addressList[0] ?? null;
    if (v.address !== undefined) {
      address = email(v.address, `${at}.address`);
      if (!addressList.includes(address)) throw new Error(`${at}.address: ${address} is not one of the addresses.`);
    }
    sources.push({ id, name: v.name === undefined ? titleCase(id) : text(v.name, `${at}.name`), channel, key, origins, address });
  }

  // ------------------------------------------------------------ links
  let crm: Config["crm"] = null;
  if (doc.crm !== undefined && doc.crm !== null) {
    if (!isObj(doc.crm)) throw new Error("crm is a map with url and token.");
    keys(doc.crm, "crm", ["url", "token"]);
    crm = { url: baseUrl(doc.crm.url, "crm.url"), token: doc.crm.token === undefined ? "HELPDESK_CRM_TOKEN" : env(doc.crm.token, "crm.token") };
  }
  let knowledgeBase: Config["knowledgeBase"] = null;
  if (doc.knowledge_base !== undefined && doc.knowledge_base !== null) {
    const k = doc.knowledge_base;
    if (!isObj(k)) throw new Error("knowledge_base is a map with url and language.");
    keys(k, "knowledge_base", ["url", "language"]);
    const lang = k.language === undefined ? null : text(k.language, "knowledge_base.language", 10);
    if (lang && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(lang)) throw new Error("knowledge_base.language is a language code, such as tr.");
    knowledgeBase = { url: baseUrl(k.url, "knowledge_base.url"), language: lang };
  }

  return {
    support: {
      name: supportName,
      language,
      timeZone,
      holidays,
      reopenWithin,
      acknowledge: bool(s.acknowledge, "support.acknowledge", false),
      maxNewPerHour: maxNewPerHour as number,
    },
    mail: { checkEvery, replyToken },
    addresses,
    queues,
    satisfaction: { askAfter },
    answers,
    sources,
    crm,
    knowledgeBase,
  };
}

/** Things to fix that do not stop the file from being applied: secrets that are not set, mail that cannot go out. */
export function configWarnings(c: Config, environment: Record<string, string | undefined>): string[] {
  const w: string[] = [];
  for (const a of c.addresses) {
    if ((a.imap || a.smtp) && !environment[a.password]) w.push(`${a.address}: ${a.password} is not set, so its mail cannot be read or sent.`);
    if (!a.imap) w.push(`${a.address}: no IMAP server (mail.imap), so mail to it is not read.`);
    if (!a.smtp) w.push(`${a.address}: no SMTP server (mail.smtp), so replies cannot be sent from it.`);
  }
  for (const s of c.sources) if (s.key && !environment[s.key]) w.push(`sources.${s.id}: ${s.key} is not set, so servers cannot post tickets to it.`);
  if (c.crm && !environment[c.crm.token]) w.push(`crm: ${c.crm.token} is not set, so customers are not looked up.`);
  if (c.queues.every((q) => q.match !== null)) w.push("No queue catches every ticket: tickets no rule matches go to the last queue.");
  return w;
}

export interface ConfigFileState {
  path: string;
  /** When the file was last read and applied, or null if it never was. */
  appliedAt: string | null;
  /** Why the file on disk is not what is applied; the last good version stays until it is fixed. */
  error: string | null;
  /** Things to fix that did not stop the file from being applied. */
  warnings: string[];
}

/**
 * Reads the file now and whenever it changes (checked every `everyMs`, by size, time and content), and hands each new
 * version and its text to `apply`, which returns warnings or throws to refuse it. A file that cannot be read or applied
 * leaves the last good version in place. `stop()` ends the polling.
 */
export function watchConfig(
  path: string,
  apply: (config: Config, text: string) => string[],
  { everyMs = 60_000, onChange }: { everyMs?: number; onChange?: (state: ConfigFileState) => void } = {},
) {
  const state: ConfigFileState = { path, appliedAt: null, error: null, warnings: [] };
  let seen = "";
  const read = () => {
    let raw: string;
    let stamp: string;
    try {
      const st = statSync(path);
      raw = readFileSync(path, "utf8");
      stamp = `${st.size}:${st.mtimeMs}:${createHash("sha256").update(raw).digest("hex")}`;
    } catch (err) {
      const error = `Cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`;
      if (state.error !== error) ((state.error = error), onChange?.(state));
      return;
    }
    if (stamp === seen) return;
    seen = stamp;
    try {
      state.warnings = apply(parseConfig(raw), raw);
      Object.assign(state, { appliedAt: new Date().toISOString(), error: null });
    } catch (err) {
      state.error = (err as Error).message;
    }
    onChange?.(state);
  };
  read();
  const timer = setInterval(read, everyMs);
  timer.unref();
  return { state, read, stop: () => clearInterval(timer) };
}
