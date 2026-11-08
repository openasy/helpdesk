// Starts the app on a random port for tests, with a clock the test moves and an outbox it reads.
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { createApp, type AppOptions } from "./app.ts";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createHelpdesk, type Options } from "./helpdesk.ts";
import type { OutgoingMail, Sender } from "./mailer.ts";

export const ADMIN_TOKEN = "test-admin-token";
export const SITE = "https://www.acme.example";
export const ENV = { HD_MAIL_PASSWORD: "mail-secret", HD_FORMS_KEY: "forms-key-0123456789", HD_CHAT_KEY: "chat-key-0123456789", HD_CRM_TOKEN: "crm-token" };

/** The settings file the tests start with. 2026-11-02 is a Monday; 12:00 UTC is 15:00 in Istanbul. */
export const SETTINGS = `
support:
  name: Acme Support
  time_zone: Europe/Istanbul
mail:
  imap: { host: 127.0.0.1, port: 1143, tls: false }
  smtp: { host: 127.0.0.1, port: 2525, tls: false }
  password: HD_MAIL_PASSWORD
addresses:
  - support@acme.example
  - it@acme.example
queues:
  billing:
    match:
      - { subject_has: [fatura, invoice] }
      - { plan: business }
    hours: weekdays 09:00-18:00
    sla: { first_reply: 4h, solution: 1d }
    sla_by_plan: { business: { first_reply: 2h } }
  sales:
    name: Sales questions
    match: { channel: chat }
    sla: { first_reply: 4h, solution: 1d }
  it:
    name: IT
    match: { address: it@acme.example }
    sla: { solution: 3d }
  general:
    sla: { first_reply: 1d }
satisfaction:
  ask_after_solved: 1h
answers:
  - { id: thanks, title: Thanks, text: "Hello {first_name}, #{number} is solved. {agent}" }
  - { id: gib, title: GIB 1150, text: "Send it again.", queues: [billing] }
sources:
  forms: { key: HD_FORMS_KEY }
  live-chat: { channel: chat, key: HD_CHAT_KEY }
  contact: { origins: ["${SITE}"] }
`;

/** A clock the test moves by hand. */
export function fakeClock(start = Date.parse("2026-11-02T12:00:00Z")) {
  let t = start;
  return Object.assign(() => t, { advance: (ms: number) => void (t += ms), set: (ms: number) => void (t = ms) });
}

/** An outbox that keeps what would be sent; `fail` makes the next sends fail. */
export function fakeSender() {
  const sent: Array<{ from: string; mail: OutgoingMail }> = [];
  let failing = 0;
  const sender: Sender & { sent: typeof sent; fail: (n: number) => void } = {
    sent,
    fail: (n) => void (failing = n),
    async send(address, _password, mail) {
      if (failing > 0) {
        failing--;
        throw new Error("connection refused");
      }
      sent.push({ from: address.address, mail });
    },
    close() {},
  };
  return sender;
}

/** A raw email, as a mail server hands it over. */
export function rawEmail(o: {
  from: string;
  to?: string;
  subject: string;
  text: string;
  id?: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
  html?: string;
}) {
  const head = [
    `From: ${o.from}`,
    `To: ${o.to ?? "support@acme.example"}`,
    `Subject: ${o.subject}`,
    `Date: Mon, 02 Nov 2026 12:00:00 +0000`,
    `Message-ID: ${o.id ?? `<${Math.random().toString(36).slice(2)}@customer.example>`}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    ...Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    "MIME-Version: 1.0",
  ];
  if (o.html) {
    return [
      ...head,
      'Content-Type: multipart/alternative; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "",
      o.text,
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      o.html,
      "--b1--",
      "",
    ].join("\r\n");
  }
  return [...head, "Content-Type: text/plain; charset=utf-8", "", o.text, ""].join("\r\n");
}

export async function startApp(opts: Partial<AppOptions> & { version: string; settings?: string; helpdesk?: Partial<Options> }) {
  const db = openDb(":memory:");
  const { settings = SETTINGS, helpdesk = {}, ...rest } = opts;
  const clock = fakeClock();
  const sender = fakeSender();
  // The origin is known once the port is, so the handler is set after listening.
  let handler: RequestListener = (_req, res) => res.writeHead(503).end();
  const server: Server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({ db, product: "helpdesk", productName: "OpenAsy Helpdesk", origin: base });
  const hd = createHelpdesk(db, { publicUrl: base, env: ENV, clock, sender, ...helpdesk });
  hd.setConfig(parseConfig(settings), settings);
  handler = createApp({ db, hd, auth, env: ENV, adminToken: ADMIN_TOKEN, publicUrl: base, ...rest });
  const admin = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json", ...init.headers } });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  /** Adds a member straight to the database, as signing up would, to own tickets. */
  const member = (id: string, name: string, email = `${id}@acme.example`) =>
    db
      .prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, 'editor', 'active', ?)")
      .run(id, email, name, new Date().toISOString());
  return { db, hd, auth, base, admin, clock, sender, member, close };
}
