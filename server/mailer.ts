// The support addresses' mail servers: IMAP to read what comes in (imapflow) and SMTP to send replies (nodemailer). Any
// mail server works; addresses on OpenAsy Mail are read and sent the same way, since Mail runs on Stalwart, which
// speaks both. Each round connects, reads what is new since the last UID it read, and logs out, so nothing stays open.
import { ImapFlow } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import type { Address, MailServer } from "./config.ts";

export interface OutgoingMail {
  from: { name: string; address: string };
  to: string[];
  cc?: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  /** With the angle brackets. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; contentType: string; content: Buffer }>;
}

export interface Sender {
  send(address: Address, password: string | undefined, mail: OutgoingMail): Promise<void>;
  /** Closes pooled connections, when the file changes and at shutdown. */
  close(): void;
}

export interface Cursor {
  uidValidity: string | null;
  lastUid: number;
}

export interface Reader {
  /**
   * Reads what is new in the address's folder since `cursor`, hands each email to `handle` in order, marks it read, and
   * returns where it got to. Stops at the first `handle` that throws, so that email is read again next round; the
   * error then carries the cursor as far as it got (`err.cursor`).
   */
  read(address: Address, password: string | undefined, cursor: Cursor, handle: (raw: Buffer) => Promise<void>): Promise<Cursor>;
}

export interface TransportOptions {
  /** For test servers only: accept certificates no authority signed. */
  insecureTls?: boolean;
  /** For test servers only: allow login without TLS. */
  allowPlain?: boolean;
  /** How far back the first round looks for unread mail. */
  firstLookBackDays?: number;
  /** At most this many emails a round, so one round never runs long. */
  perRound?: number;
}

const key = (a: Address, s: MailServer, password: string | undefined) => `${a.user}|${s.host}|${s.port}|${s.tls}|${password ?? ""}`;

export function smtpSender(o: TransportOptions = {}): Sender {
  const pool = new Map<string, Transporter>();
  return {
    async send(address, password, mail) {
      const s = address.smtp;
      if (!s) throw new Error(`${address.address} has no SMTP server in the settings file.`);
      const k = key(address, s, password);
      let t = pool.get(k);
      if (!t) {
        t = nodemailer.createTransport({
          host: s.host,
          port: s.port,
          secure: s.tls,
          requireTLS: !s.tls && !o.allowPlain,
          ignoreTLS: !s.tls && !!o.allowPlain,
          auth: password ? { user: address.user, pass: password } : undefined,
          connectionTimeout: 15_000,
          greetingTimeout: 15_000,
          socketTimeout: 30_000,
          tls: o.insecureTls ? { rejectUnauthorized: false } : undefined,
        });
        pool.set(k, t);
      }
      await t.sendMail({
        from: mail.from,
        to: mail.to,
        cc: mail.cc,
        replyTo: mail.replyTo,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        messageId: mail.messageId,
        inReplyTo: mail.inReplyTo,
        references: mail.references,
        headers: mail.headers,
        attachments: mail.attachments,
        envelope: { from: address.address, to: [...mail.to, ...(mail.cc ?? [])] },
      });
    },
    close() {
      for (const t of pool.values()) t.close();
      pool.clear();
    },
  };
}

export function imapReader(o: TransportOptions = {}): Reader {
  return {
    async read(address, password, cursor, handle) {
      const s = address.imap;
      if (!s) throw new Error(`${address.address} has no IMAP server in the settings file.`);
      if (!password) throw new Error(`${address.password} is not set.`);
      const client = new ImapFlow({
        host: s.host,
        port: s.port,
        secure: s.tls,
        doSTARTTLS: s.tls ? undefined : !o.allowPlain,
        auth: { user: address.user, pass: password },
        logger: false,
        disableAutoIdle: true,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        tls: o.insecureTls ? { rejectUnauthorized: false } : undefined,
      });
      // A dropped connection is reported by the command that was running; this keeps it from being an uncaught error.
      client.on("error", () => {});
      await client.connect();
      let next = { ...cursor };
      let failure: Error | null = null;
      try {
        const lock = await client.getMailboxLock(address.folder);
        try {
          const box = client.mailbox;
          const validity = box ? String(box.uidValidity) : null;
          let uids: number[];
          if (!validity || validity !== cursor.uidValidity) {
            // First time, or the folder was made again: the unread mail of the last days. Emails read before are
            // recognised by their Message-ID, so nothing becomes a ticket twice.
            const since = new Date(Date.now() - (o.firstLookBackDays ?? 14) * 86_400_000);
            uids = ((await client.search({ seen: false, since }, { uid: true })) || []) as number[];
            next = { uidValidity: validity, lastUid: 0 };
          } else {
            uids = (((await client.search({ uid: `${cursor.lastUid + 1}:*` }, { uid: true })) || []) as number[]).filter((u) => u > cursor.lastUid);
          }
          for (const uid of [...new Set(uids)].sort((a, b) => a - b).slice(0, o.perRound ?? 100)) {
            const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
            try {
              if (msg && msg.source) await handle(msg.source);
            } catch (err) {
              failure = err as Error;
              break;
            }
            next.lastUid = Math.max(next.lastUid, uid);
            await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => client.close());
      }
      // What was read before the email that failed stays read.
      if (failure) throw Object.assign(failure, { cursor: next });
      return next;
    },
  };
}
