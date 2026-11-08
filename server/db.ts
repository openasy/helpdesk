import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Forward-only migrations (ADR 0010): append new entries, never edit or remove old ones.
const MIGRATIONS = [
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   -- A ticket. Its number is what customers and agents say: #1001. The queue is a queue id from the file.
   CREATE TABLE tickets (
     number INTEGER PRIMARY KEY AUTOINCREMENT,
     subject TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('open', 'waiting', 'solved', 'closed')),
     priority TEXT NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
     queue TEXT NOT NULL,
     channel TEXT NOT NULL CHECK (channel IN ('email', 'form', 'chat')),
     -- The support address it came to, or the source id from the file for forms and chats.
     source TEXT NOT NULL,
     form TEXT,
     -- The address replies go out from; null when there is none.
     address TEXT,
     -- Why it is in its queue, as people read it: subject has "invoice".
     routed_by TEXT NOT NULL,
     customer_email TEXT,
     customer_name TEXT,
     -- The customer's plan from CRM when the ticket was opened, and their contact id there.
     plan TEXT,
     crm_id TEXT,
     language TEXT,
     -- What Forms or Live Chat calls this ticket, so the same post twice opens one ticket.
     external_id TEXT,
     owner_id TEXT,
     owner_name TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     first_reply_at TEXT,
     solved_at TEXT,
     closed_at TEXT,
     -- The SLA clocks, in ms of working time in the queue's hours (see sla.ts).
     fr_target INTEGER,
     fr_elapsed INTEGER NOT NULL DEFAULT 0,
     fr_done_at TEXT,
     fr_breached_at TEXT,
     sol_target INTEGER,
     sol_elapsed INTEGER NOT NULL DEFAULT 0,
     sol_done_at TEXT,
     sol_breached_at TEXT,
     -- When the clocks last started running; null while they are paused or stopped.
     run_since TEXT,
     -- Satisfaction: the link's secret, when it was asked, and the answer.
     csat_token TEXT UNIQUE,
     csat_asked_at TEXT,
     csat_score INTEGER CHECK (csat_score BETWEEN 1 AND 5),
     csat_comment TEXT,
     csat_at TEXT,
     -- The ticket an email after the reopen window followed.
     follows INTEGER,
     UNIQUE (source, external_id)
   );
   -- Numbers start at 1001, so the first tickets do not read as #1 and #2.
   INSERT INTO sqlite_sequence (name, seq) VALUES ('tickets', 1000);
   CREATE INDEX tickets_status ON tickets (status, queue);
   CREATE INDEX tickets_created ON tickets (created_at);
   CREATE INDEX tickets_customer ON tickets (customer_email, created_at);
   CREATE INDEX tickets_solved ON tickets (solved_at) WHERE solved_at IS NOT NULL;
   -- What is in a ticket's thread: the customer's messages, replies from the support address, internal notes, and what
   -- Helpdesk did (system).
   CREATE TABLE messages (
     id TEXT PRIMARY KEY,
     ticket INTEGER NOT NULL REFERENCES tickets (number) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('customer', 'agent', 'note', 'system')),
     via TEXT NOT NULL CHECK (via IN ('email', 'form', 'chat', 'web', 'helpdesk')),
     author_id TEXT,
     author_name TEXT NOT NULL,
     author_email TEXT,
     at TEXT NOT NULL,
     subject TEXT,
     -- Plain text: the new part, and the whole message with what it quoted.
     body TEXT NOT NULL,
     full_text TEXT,
     -- Sanitized HTML of an email, when it had HTML; safe to show.
     html TEXT,
     -- RFC 5322 Message-ID, with the angle brackets, for threading.
     message_id TEXT,
     to_addrs TEXT,
     cc_addrs TEXT,
     -- Replies: queued until the mail server took them, then sent, or failed after the last try.
     delivery TEXT CHECK (delivery IN ('queued', 'sent', 'failed')),
     delivery_error TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at TEXT,
     -- For system lines: a code the UI words, with its values as JSON.
     event TEXT,
     data TEXT
   );
   CREATE INDEX messages_ticket ON messages (ticket, at);
   CREATE UNIQUE INDEX messages_message_id ON messages (message_id) WHERE message_id IS NOT NULL;
   CREATE INDEX messages_outbox ON messages (next_attempt_at) WHERE delivery = 'queued';
   CREATE TABLE attachments (
     id TEXT PRIMARY KEY,
     message TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
     filename TEXT NOT NULL,
     content_type TEXT NOT NULL,
     size INTEGER NOT NULL,
     content_id TEXT,
     data BLOB NOT NULL
   );
   CREATE INDEX attachments_message ON attachments (message);
   -- Where reading each support address's folder got to: the folder's UIDVALIDITY and the last UID read.
   CREATE TABLE mailboxes (
     address TEXT PRIMARY KEY,
     folder TEXT NOT NULL,
     uid_validity TEXT,
     last_uid INTEGER NOT NULL DEFAULT 0,
     checked_at TEXT,
     ok_at TEXT,
     error TEXT
   );
   -- Emails that did not become a ticket or a reply, and why: auto-replies, bounces, loops. Kept 30 days, for the
   -- Integrations page and to explain a missing ticket.
   CREATE TABLE ignored (
     id INTEGER PRIMARY KEY,
     at TEXT NOT NULL,
     address TEXT NOT NULL,
     sender TEXT,
     subject TEXT,
     reason TEXT NOT NULL
   );
   CREATE INDEX ignored_at ON ignored (at);`,
];

/** Opens the product's single SQLite file in WAL mode (ADR 0011) and migrates it forward. */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get() as { v: number };
  for (let v = row.v; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(v + 1, new Date().toISOString());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
