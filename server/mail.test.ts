// The mail path end to end, in process: imapflow reads a small IMAP server, nodemailer sends to smtp-server, and the
// customer's answer to the reply comes back to the same ticket.
import type { AddressInfo } from "node:net";
import { createAuth } from "@openasy/auth";
import { SMTPServer } from "smtp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { parseEmail } from "./email.ts";
import { createHelpdesk } from "./helpdesk.ts";
import { imapReader, smtpSender } from "./mailer.ts";
import { ENV, fakeClock, rawEmail, SETTINGS } from "./test-app.ts";
import { startImap } from "./test-imap.ts";

let imap: Awaited<ReturnType<typeof startImap>>;
let smtp: SMTPServer;
let smtpPort = 0;
const received: Array<{ from: string; to: string[]; raw: string }> = [];

beforeAll(async () => {
  imap = await startImap({ user: "support@acme.example", pass: ENV.HD_MAIL_PASSWORD });
  smtp = new SMTPServer({
    authOptional: false,
    allowInsecureAuth: true,
    disabledCommands: ["STARTTLS"],
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === "support@acme.example" && auth.password === ENV.HD_MAIL_PASSWORD) cb(null, { user: auth.username });
      else cb(new Error("Invalid username or password"));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString("utf8"),
        });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  smtpPort = (smtp.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await imap.close();
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
});

function make(password = ENV.HD_MAIL_PASSWORD) {
  const db = openDb(":memory:");
  createAuth({ db, product: "helpdesk", productName: "OpenAsy Helpdesk", origin: "https://help.acme.example" });
  const settings = SETTINGS.replace("port: 1143", `port: ${imap.port}`).replace("port: 2525", `port: ${smtpPort}`);
  const sender = smtpSender({ allowPlain: true });
  const hd = createHelpdesk(db, {
    publicUrl: "https://help.acme.example",
    env: { ...ENV, HD_MAIL_PASSWORD: password },
    clock: fakeClock(),
    sender,
    reader: imapReader({ allowPlain: true }),
  });
  hd.setConfig(parseConfig(settings), settings);
  return { hd, sender };
}

describe("mail over IMAP and SMTP", () => {
  it("reads new mail into tickets, sends threaded replies, and threads the answer back", async () => {
    const { hd, sender } = make();
    imap.deliver(rawEmail({ from: '"Gizem Avcı" <gizem@avci.example>', subject: "Invoices fail to send", text: "Code 1150.", id: "<g1@avci.example>" }));
    await hd.checkMail(true);
    expect(hd.list(new URLSearchParams()).map((t) => t.number)).toEqual([1001]);
    expect(imap.mail[0]!.seen).toBe(true);
    expect(imap.commands).toEqual(expect.arrayContaining(["LOGIN", "SELECT", "UID SEARCH", "UID FETCH", "UID STORE", "LOGOUT"]));
    expect(hd.mail().addresses[0]).toMatchObject({ address: "support@acme.example", error: null, reading: true, sending: true, passwordSet: true });

    // Nothing new: nothing changes, and the same email is not read twice.
    await hd.checkMail(true);
    expect(hd.list(new URLSearchParams())).toHaveLength(1);

    const m = await hd.reply({ id: "u1", name: "Emily Clark" }, 1001, { text: "It is fixed since 10:40; please send them again." });
    expect(m.delivery).toBe("sent");
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ from: "support@acme.example", to: ["gizem@avci.example"] });
    const sent = await parseEmail(received[0]!.raw);
    expect(sent.subject).toBe("Re: Invoices fail to send [#1001]");
    expect(sent.inReplyTo).toEqual(["<g1@avci.example>"]);
    expect(sent.references).toEqual(["<g1@avci.example>"]);
    expect(sent.messageId).toMatch(/^<hd\.1001\.[0-9a-f]{12}@acme\.example>$/);
    expect(sent.ours).toBe("1001");
    expect(sent.text).toContain("> Code 1150.");

    // The customer's mail app answers with In-Reply-To and References.
    imap.deliver(
      rawEmail({
        from: "gizem@avci.example",
        subject: sent.subject,
        text: "Sent again, all went out. Thanks!\n\nOn Mon, Acme Support wrote:\n> It is fixed",
        inReplyTo: sent.messageId!,
        references: `<g1@avci.example> ${sent.messageId}`,
      }),
    );
    await hd.checkMail(true);
    const t = hd.detail(1001);
    expect(hd.list(new URLSearchParams())).toHaveLength(1);
    expect(t.status).toBe("open");
    expect(t.messages.filter((x) => x.kind === "customer").map((x) => x.body)).toEqual(["Code 1150.", "Sent again, all went out. Thanks!"]);
    sender.close();
  });

  it("keeps the error when the mail server refuses the password, and reads nothing", async () => {
    const { hd } = make("wrong");
    const before = imap.mail.length;
    imap.deliver(rawEmail({ from: "a@b.example", subject: "Hello", text: "x" }));
    await hd.checkMail(true);
    expect(hd.mail().addresses[0]!.error).toBeTruthy();
    expect(hd.list(new URLSearchParams())).toHaveLength(0);
    expect(imap.mail[before]!.seen).toBe(false);
    // A reply cannot go out with the wrong password either: it waits in the outbox.
  });
});
