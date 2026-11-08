// End to end against a running Stalwart (e2e/run.sh starts one): its first start through its API, a support address and
// a customer, then Helpdesk reading the support address over IMAP, replying over SMTP, and threading the customer's
// answer back to the same ticket, while an out-of-office opens nothing.
//
//   SW=http://localhost:18090 SW_RECOVERY=... SW_CONTAINER=helpdesk-e2e-sw node e2e/stalwart.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createAuth } from "@openasy/auth";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { parseConfig } from "../server/config.ts";
import { openDb } from "../server/db.ts";
import { parseEmail } from "../server/email.ts";
import { createHelpdesk } from "../server/helpdesk.ts";
import { imapReader, smtpSender } from "../server/mailer.ts";

const SW = (process.env.SW ?? "http://localhost:18090").replace(/\/$/, "");
const IMAP_PORT = Number(process.env.SW_IMAP_PORT ?? 11994);
const SMTP_PORT = Number(process.env.SW_SMTP_PORT ?? 11465);
const RECOVERY = `admin:${process.env.SW_RECOVERY ?? ""}`;
const CONTAINER = process.env.SW_CONTAINER ?? "helpdesk-e2e-sw";
const DOMAIN = "acme.test";
const SUPPORT = { name: "support", password: "e2e-support-password-0123" };
const CUSTOMER = { name: "gizem", password: "e2e-customer-password-0123" };

let failures = 0;
async function step(name: string, work: () => Promise<void>) {
  try {
    await work();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${(err as Error).stack?.split("\n").slice(0, 5).join("\n  ")}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(work: () => Promise<T>, tries = 30): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await work();
    } catch (err) {
      if (i >= tries) throw err;
      await sleep(1000);
    }
  }
}

type Answer = [string, Record<string, any>, string];
async function admin(methodCalls: unknown[]): Promise<Answer[]> {
  const res = await fetch(`${SW}/jmap/`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(RECOVERY).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify({ using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"], methodCalls }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Stalwart answered ${res.status}`);
  return ((await res.json()) as { methodResponses: Answer[] }).methodResponses;
}
function check(r: Answer | undefined) {
  if (!r || r[0] === "error") throw new Error(`Stalwart: ${JSON.stringify(r?.[1])}`);
  const failed = ["notCreated", "notUpdated"].flatMap((k) => Object.values((r[1][k] as Record<string, unknown> | null) ?? {}));
  if (failed.length) throw new Error(`Stalwart: ${JSON.stringify(failed)}`);
  return r[1];
}

await step("Stalwart's first start is done, with a support address and a customer", async () => {
  const [probe] = await admin([["x:Domain/get", { properties: ["name"] }, "0"]]);
  if (probe?.[0] === "error" && /bootstrap/i.test(String(probe[1].description))) {
    check(
      (
        await admin([
          ["x:Bootstrap/set", { update: { singleton: { serverHostname: `mail.${DOMAIN}`, defaultDomain: DOMAIN, requestTlsCertificate: false } } }, "0"],
        ])
      )[0],
    );
    execFileSync("docker", ["restart", CONTAINER], { stdio: "ignore" });
  }
  const domains = (await eventually(async () => check((await admin([["x:Domain/get", { properties: ["name"] }, "0"]]))[0]))).list as Array<{
    id: string;
    name: string;
  }>;
  const domainId = domains.find((d) => d.name === DOMAIN)!.id;
  for (const a of [SUPPORT, CUSTOMER])
    check(
      (
        await admin([
          [
            "x:Account/set",
            {
              create: {
                a: {
                  "@type": "User",
                  name: a.name,
                  domainId,
                  encryptionAtRest: { "@type": "Disabled" },
                  credentials: { "0": { "@type": "Password", secret: a.password } },
                },
              },
            },
            "0",
          ],
        ])
      )[0],
    );
});

const db = openDb(":memory:");
createAuth({ db, product: "helpdesk", productName: "OpenAsy Helpdesk", origin: "https://help.acme.test" });
const settings = `
support: { name: Acme Support }
mail:
  imap: { host: 127.0.0.1, port: ${IMAP_PORT}, tls: true }
  smtp: { host: 127.0.0.1, port: ${SMTP_PORT}, tls: true }
  password: E2E_SUPPORT_PASSWORD
addresses:
  - support@${DOMAIN}
queues:
  billing: { match: { subject_has: invoice }, sla: { first_reply: 4h } }
  general: {}
`;
// Stalwart's own certificate until it has one for its name: not checked here.
const sender = smtpSender({ insecureTls: true });
const hd = createHelpdesk(db, {
  publicUrl: "https://help.acme.test",
  env: { E2E_SUPPORT_PASSWORD: SUPPORT.password },
  sender,
  reader: imapReader({ insecureTls: true }),
});
hd.setConfig(parseConfig(settings), settings);
const customer = nodemailer.createTransport({
  host: "127.0.0.1",
  port: SMTP_PORT,
  secure: true,
  auth: { user: `${CUSTOMER.name}@${DOMAIN}`, pass: CUSTOMER.password },
  tls: { rejectUnauthorized: false },
});

/** The customer's INBOX, newest last. */
async function customerInbox() {
  const c = new ImapFlow({
    host: "127.0.0.1",
    port: IMAP_PORT,
    secure: true,
    auth: { user: `${CUSTOMER.name}@${DOMAIN}`, pass: CUSTOMER.password },
    logger: false,
    tls: { rejectUnauthorized: false },
  });
  c.on("error", () => {});
  await c.connect();
  const lock = await c.getMailboxLock("INBOX");
  const out: Buffer[] = [];
  try {
    for await (const m of c.fetch("1:*", { source: true })) if (m.source) out.push(m.source);
  } catch {
    // An empty folder has no 1:*.
  } finally {
    lock.release();
    await c.logout();
  }
  return Promise.all(out.map((raw) => parseEmail(raw)));
}

let replyId = "";
await step("an email to the support address becomes a ticket", async () => {
  await customer.sendMail({
    from: `Gizem Avcı <${CUSTOMER.name}@${DOMAIN}>`,
    to: `support@${DOMAIN}`,
    subject: "Invoices fail to send",
    text: "Rejected by GİB, code 1150.",
    messageId: `<g1@${DOMAIN}>`,
  });
  await eventually(async () => {
    await hd.checkMail(true);
    assert.equal(hd.list(new URLSearchParams()).length, 1, hd.mail().addresses[0]?.error ?? "no ticket yet");
  });
  const t = hd.detail(1001);
  assert.equal(t.queue.id, "billing");
  assert.equal(t.customer.email, `${CUSTOMER.name}@${DOMAIN}`);
});

await step("the reply goes out over SMTP from the support address and reaches the customer threaded", async () => {
  const m = await hd.reply({ id: "u1", name: "Emily Clark" }, 1001, { text: "Fixed since 10:40; please send them again." });
  assert.equal(m.delivery, "sent", m.deliveryError ?? "");
  const got = await eventually(async () => {
    const inbox = await customerInbox();
    const r = inbox.find((x) => x.subject === "Re: Invoices fail to send [#1001]");
    assert.ok(r, "the reply is not in the customer's inbox yet");
    return r;
  });
  assert.deepEqual(got.inReplyTo, [`<g1@${DOMAIN}>`]);
  assert.equal(got.from?.email, `support@${DOMAIN}`);
  assert.match(got.messageId ?? "", /^<hd\.1001\.[0-9a-f]{12}@acme\.test>$/);
  replyId = got.messageId!;
});

await step("an out-of-office to the reply opens nothing", async () => {
  await customer.sendMail({
    from: `${CUSTOMER.name}@${DOMAIN}`,
    to: `support@${DOMAIN}`,
    subject: "Automatic reply: Re: Invoices fail to send [#1001]",
    text: "I am away until Monday.",
    inReplyTo: replyId,
    headers: { "Auto-Submitted": "auto-replied" },
  });
  await eventually(async () => {
    await hd.checkMail(true);
    assert.ok(
      hd.detail(1001).messages.some((x) => x.event === "auto-reply"),
      "the auto-reply is not read yet",
    );
  });
  assert.equal(hd.list(new URLSearchParams()).length, 1);
  assert.equal(hd.detail(1001).status, "waiting");
});

await step("the customer's answer threads back into the same ticket", async () => {
  await customer.sendMail({
    from: `${CUSTOMER.name}@${DOMAIN}`,
    to: `support@${DOMAIN}`,
    subject: "Re: Invoices fail to send [#1001]",
    text: "All sent, thanks!",
    inReplyTo: replyId,
    references: [`<g1@${DOMAIN}>`, replyId],
  });
  await eventually(async () => {
    await hd.checkMail(true);
    assert.equal(hd.detail(1001).messages.filter((x) => x.kind === "customer").length, 2, "the answer is not read yet");
  });
  assert.equal(hd.list(new URLSearchParams()).length, 1);
  assert.equal(hd.detail(1001).status, "open");
});

sender.close();
customer.close();
console.log(failures ? `# ${failures} failed` : "# all passed");
process.exit(failures ? 1 : 0);
