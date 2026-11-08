import { createAuth } from "@openasy/auth";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createHelpdesk, type Actor, type Options } from "./helpdesk.ts";
import type { CrmCustomer } from "./links.ts";
import { ENV, fakeClock, fakeSender, rawEmail, SETTINGS } from "./test-app.ts";

const H = 3_600_000;
const MIN = 60_000;
const EMILY: Actor = { id: "u-emily", name: "Emily Clark" };

function make(o: { settings?: string; crm?: Record<string, CrmCustomer | "down">; opts?: Partial<Options> } = {}) {
  const db = openDb(":memory:");
  // The members' table, which owners come from.
  createAuth({ db, product: "helpdesk", productName: "OpenAsy Helpdesk", origin: "https://help.acme.example" });
  const clock = fakeClock();
  const sender = fakeSender();
  const crm = o.crm;
  const hd = createHelpdesk(db, {
    publicUrl: "https://help.acme.example",
    env: ENV,
    clock,
    sender,
    crm: crm
      ? () => ({
          lookup: async (email) => {
            const c = crm[email];
            if (c === "down") throw new Error("CRM answered 502");
            return c ?? null;
          },
        })
      : undefined,
    ...o.opts,
  });
  const settings = o.settings ?? SETTINGS;
  hd.setConfig(parseConfig(settings), settings);
  db.prepare("INSERT INTO auth_users (id, email, name, role, status, created_at) VALUES (?, ?, ?, 'editor', 'active', ?)").run(
    EMILY.id,
    "emily@acme.example",
    EMILY.name,
    new Date().toISOString(),
  );
  const support = hd.config()!.addresses[0]!;
  const it = hd.config()!.addresses[1]!;
  const mail = (o2: Parameters<typeof rawEmail>[0], to = support) => hd.ingestEmail(to, rawEmail(o2));
  return { db, hd, clock, sender, mail, support, it };
}

const gizem = { from: '"Gizem Avcı" <gizem@avci.example>', subject: "Invoices fail to send since this morning", text: "Rejected by GİB, code 1150." };

describe("a ticket from an email", () => {
  it("opens in the queue its rule picks, with the SLA of the queue, in its hours", async () => {
    const { hd, mail } = make();
    const r = await mail({ ...gizem, id: "<g1@avci.example>" });
    expect(r).toEqual({ action: "ticket", ticket: 1001 });
    const t = hd.detail(1001);
    expect(t).toMatchObject({
      subject: gizem.subject,
      status: "open",
      queue: { id: "billing", name: "Billing" },
      channel: "email",
      customer: { email: "gizem@avci.example", name: "Gizem Avcı" },
    });
    expect(t.routedBy).toBe('subject has "invoice"');
    expect(t.messages.map((m) => m.kind)).toEqual(["system", "customer"]);
    expect(t.messages[0]!.body).toBe(
      'Opened from an email to support@acme.example. Routed to Billing by the rule subject has "invoice"; SLA first reply 4h, solution 1d.',
    );
    // Monday 15:00 in Istanbul, 4 working hours of 09:00 to 18:00: due Tuesday 10:00, 07:00 UTC.
    expect(t.clocks.firstReply).toMatchObject({ state: "running", dueAt: "2026-11-03T07:00:00.000Z", remaining: 4 * H });
    expect(t.sla).toMatchObject({ which: "firstReply", state: "running" });
  });

  it("is routed by the address it was sent to", async () => {
    const { hd, mail } = make();
    await mail({ ...gizem, to: "it@acme.example", subject: "Laptop for a new hire" });
    expect(hd.detail(1001).queue.id).toBe("it");
  });

  it("is routed by the customer's plan from CRM, matched by email", async () => {
    const crm: Record<string, CrmCustomer> = {
      "gizem@avci.example": {
        contact: {
          id: "c1",
          name: "Gizem Avcı",
          email: "gizem@avci.example",
          title: null,
          company: null,
          plan: { id: "business", name: "Business", renews: null },
          owner: null,
          url: null,
        },
        deals: [],
      },
    };
    const { hd, mail } = make({ crm });
    await mail({ ...gizem, subject: "Hello there" });
    const t = hd.detail(1001);
    expect(t).toMatchObject({ queue: { id: "billing" }, routedBy: "plan business", plan: "business" });
    expect(t.clocks.firstReply!.target).toBe(2 * H);
    expect(t.clocks.firstReplyText).toBe("2h");
  });

  it("is routed without the plan when CRM does not answer, and says so", async () => {
    const { hd, mail } = make({ crm: { "gizem@avci.example": "down" } });
    await mail({ ...gizem, subject: "Hello there" });
    const t = hd.detail(1001);
    expect(t.queue.id).toBe("general");
    expect(t.messages.find((m) => m.event === "crm-unavailable")?.body).toMatch(/CRM did not answer/);
  });

  it("keeps the email's HTML sanitized and the new part of its text", async () => {
    const { hd, mail } = make();
    await mail({ ...gizem, text: "It fails.\n\nOn Mon, someone wrote:\n> old", html: '<p onclick="x()">It <b>fails</b>.</p><script>alert(1)</script>' });
    const m = hd.detail(1001).messages[1]!;
    expect(m.body).toBe("It fails.");
    expect(m.fullText).toContain("> old");
    expect(m.html).toBe("<p>It <b>fails</b>.</p>");
  });
});

describe("the SLA clocks", () => {
  it("stop the first-reply clock at the reply, and pause while waiting on the customer", async () => {
    const { hd, mail, clock, sender } = make();
    await mail({ ...gizem, id: "<g1@avci.example>" });
    clock.advance(H);
    await hd.reply(EMILY, 1001, { text: "We are on it." });
    let t = hd.detail(1001);
    expect(t.status).toBe("waiting");
    expect(t.owner).toEqual({ id: EMILY.id, name: EMILY.name });
    expect(t.clocks.firstReply).toMatchObject({ state: "met", elapsed: H, doneAt: "2026-11-02T13:00:00.000Z" });
    expect(t.clocks.solution).toMatchObject({ state: "paused", elapsed: H, dueAt: null });
    expect(t.sla).toMatchObject({ which: "solution", state: "paused" });

    // Two days waiting on the customer count nothing.
    clock.advance(48 * H);
    t = hd.detail(1001);
    expect(t.clocks.solution!.elapsed).toBe(H);

    // The customer answers the reply: same ticket, open again, and the clock runs from now.
    const reply = sender.sent[0]!.mail;
    const r = await mail({
      from: gizem.from,
      subject: `Re: ${gizem.subject} [#1001]`,
      text: "Still failing.",
      inReplyTo: reply.messageId,
      references: `<g1@avci.example> ${reply.messageId}`,
    });
    expect(r).toEqual({ action: "reply", ticket: 1001 });
    t = hd.detail(1001);
    expect(t.status).toBe("open");
    expect(t.clocks.solution!.state).toBe("running");
    // Wednesday 16:00 (13:00 UTC) with 8 working hours left: due Thursday 15:00.
    expect(t.clocks.solution!.dueAt).toBe("2026-11-05T12:00:00.000Z");
  });

  it("run only in working hours", async () => {
    const { hd, mail, clock } = make();
    // Friday 17:00 in Istanbul.
    clock.set(Date.parse("2026-11-06T14:00:00Z"));
    await mail(gizem);
    clock.set(Date.parse("2026-11-09T07:00:00Z")); // Monday 10:00
    const t = hd.detail(1001);
    expect(t.clocks.firstReply).toMatchObject({ state: "running", elapsed: 2 * H, remaining: 2 * H });
  });

  it("are missed once past the target, and stay missed", async () => {
    const { hd, mail, clock } = make();
    await mail(gizem);
    clock.advance(26 * H); // Tuesday 17:00: 3 + 8 working hours
    let t = hd.detail(1001);
    expect(t.clocks.firstReply).toMatchObject({ state: "missed", missedAt: "2026-11-03T07:00:00.000Z" });
    expect(hd.overview()).toMatchObject({ missedNow: 1, open: 1, unassigned: 1 });
    expect(hd.overview().atRisk.map((x) => x.number)).toEqual([1001]);
    await hd.reply(EMILY, 1001, { text: "Sorry for the wait." });
    t = hd.detail(1001);
    expect(t.clocks.firstReply).toMatchObject({ state: "missed", doneAt: "2026-11-03T14:00:00.000Z" });
  });

  it("start over with the new queue's SLA after a move, unless met or missed", async () => {
    const { hd, mail, clock } = make();
    await mail({ ...gizem, subject: "Hello" });
    expect(hd.detail(1001).queue.id).toBe("general");
    clock.advance(H);
    const t = hd.update(EMILY, 1001, { queue: "billing" });
    expect(t.queue.id).toBe("billing");
    expect(t.clocks.firstReply).toMatchObject({ state: "running", elapsed: 0, target: 4 * H });
    expect(t.messages.at(-1)!.event).toBe("moved");
  });

  it("stop the solution clock when solved, and run on from there when the customer reopens it", async () => {
    const { hd, mail, clock } = make();
    await mail({ ...gizem, id: "<g1@avci.example>" });
    clock.advance(30 * MIN);
    await hd.reply(EMILY, 1001, { text: "Fixed, please try again.", status: "solved" });
    let t = hd.detail(1001);
    expect(t.status).toBe("solved");
    expect(t.clocks.solution).toMatchObject({ state: "met", elapsed: 30 * MIN });
    clock.advance(H);
    await mail({ from: gizem.from, subject: `Re: ${gizem.subject} [#1001]`, text: "No, it fails again." });
    t = hd.detail(1001);
    expect(t.status).toBe("open");
    expect(t.clocks.solution).toMatchObject({ state: "running", elapsed: 30 * MIN });
    expect(t.messages.some((m) => m.event === "reopened")).toBe(true);
  });
});

describe("replies from the support address", () => {
  it("thread in the customer's mail app and carry the ticket's number", async () => {
    const { hd, mail, sender } = make();
    await mail({ ...gizem, id: "<g1@avci.example>" });
    const m = await hd.reply(EMILY, 1001, { text: "Please send the invoices again.", cc: ["finance@avci.example"] });
    expect(m).toMatchObject({
      kind: "agent",
      delivery: "sent",
      author: { name: "Emily Clark", email: "support@acme.example" },
      body: "Please send the invoices again.",
    });
    const out = sender.sent[0]!;
    expect(out.from).toBe("support@acme.example");
    expect(out.mail).toMatchObject({
      from: { name: "Acme Support", address: "support@acme.example" },
      to: ["gizem@avci.example"],
      cc: ["finance@avci.example"],
      subject: "Re: Invoices fail to send since this morning [#1001]",
      inReplyTo: "<g1@avci.example>",
      references: ["<g1@avci.example>"],
      headers: { "X-OpenAsy-Helpdesk": "1001" },
    });
    expect(out.mail.messageId).toMatch(/^<hd\.1001\.[0-9a-f]{12}@acme\.example>$/);
    expect(out.mail.text).toMatch(/^Please send the invoices again\.\n\nOn .* Gizem Avcı <gizem@avci.example> wrote:\n> Rejected by GİB, code 1150\.$/);
    expect(out.mail.headers!["Auto-Submitted"]).toBeUndefined();
  });

  it("carry the ticket in the reply address when the file says so", async () => {
    const { hd, mail, sender } = make({ settings: SETTINGS.replace("password: HD_MAIL_PASSWORD", "password: HD_MAIL_PASSWORD\n  reply_token: address") });
    await mail(gizem);
    await hd.reply(EMILY, 1001, { text: "Hi" });
    const out = sender.sent[0]!.mail;
    expect(out.subject).toBe("Re: Invoices fail to send since this morning");
    expect(out.replyTo).toMatch(/^support\+1001-[0-9a-f]{8}@acme\.example$/);
    // A mail app that drops the headers still threads through the address.
    const r = await mail({ from: gizem.from, to: out.replyTo!, subject: "Re: Invoices fail to send since this morning", text: "Thanks" });
    expect(r).toEqual({ action: "reply", ticket: 1001 });
  });

  it("thread by the number in the subject only from people already in the ticket", async () => {
    const { mail } = make();
    await mail(gizem);
    expect(await mail({ from: "gizem@avci.example", subject: "Re: something [#1001]", text: "more" })).toEqual({ action: "reply", ticket: 1001 });
    expect(await mail({ from: "stranger@else.example", subject: "Re: something [#1001]", text: "inject" })).toEqual({ action: "ticket", ticket: 1002 });
  });

  it("are tried again when the mail server is down, and fail after the last try", async () => {
    const { hd, mail, sender, clock } = make();
    await mail(gizem);
    sender.fail(1);
    const m = await hd.reply(EMILY, 1001, { text: "Hi" });
    expect(m.delivery).toBe("queued");
    expect(m.deliveryError).toBe("connection refused");
    clock.advance(MIN);
    await hd.tick();
    expect(hd.detail(1001).messages.find((x) => x.id === m.id)!.delivery).toBe("sent");

    sender.fail(10);
    const m2 = await hd.reply(EMILY, 1001, { text: "Again" });
    for (let i = 0; i < 6; i++) {
      clock.advance(3 * H);
      await hd.tick();
    }
    const t = hd.detail(1001);
    expect(t.messages.find((x) => x.id === m2.id)!.delivery).toBe("failed");
    expect(t.messages.at(-1)!.event).toBe("delivery-failed");
  });

  it("cannot go to a chat with no email", async () => {
    const { hd } = make();
    const r = await hd.intake("live-chat", { transcript: [{ from: "customer", text: "Hi, can invoices be in English?" }] }, true);
    await expect(hd.reply(EMILY, r.ticket.number, { text: "Yes" })).rejects.toThrow(/no customer email/);
  });
});

describe("loops, auto-replies and bounces", () => {
  it("open no ticket for an automatic email, and note an out-of-office on its ticket", async () => {
    const { hd, mail, sender } = make();
    await mail(gizem);
    await hd.reply(EMILY, 1001, { text: "Hi" });
    const ours = sender.sent[0]!.mail.messageId;
    const r = await mail({
      from: gizem.from,
      subject: "Automatic reply: Re: Invoices",
      text: "I am away.",
      inReplyTo: ours,
      headers: { "Auto-Submitted": "auto-replied" },
    });
    expect(r).toEqual({ action: "ignored", reason: "automatic: Auto-Submitted: auto-replied", ticket: 1001 });
    const t = hd.detail(1001);
    expect(t.status).toBe("waiting");
    expect(t.messages.at(-1)).toMatchObject({ kind: "system", event: "auto-reply" });
    expect(
      await mail({ from: "news@shop.example", subject: "Our offers", text: "x", headers: { "List-Unsubscribe": "<mailto:u@shop.example>" } }),
    ).toMatchObject({ action: "ignored" });
    expect(hd.list(new URLSearchParams()).length).toBe(1);
  });

  it("open no ticket for mail from the support addresses or from Helpdesk itself", async () => {
    const { mail } = make();
    expect(await mail({ from: "it@acme.example", subject: "Hi", text: "x" })).toMatchObject({ action: "ignored", reason: "sent from a support address" });
    expect(await mail({ from: "x@else.example", subject: "Hi", text: "x", headers: { "X-OpenAsy-Helpdesk": "1001" } })).toMatchObject({
      reason: "sent by Helpdesk itself",
    });
  });

  it("stop a sender who opens too many tickets in an hour", async () => {
    const { mail } = make({ settings: SETTINGS.replace("time_zone: Europe/Istanbul", "time_zone: Europe/Istanbul\n  max_new_per_hour: 3") });
    for (let i = 0; i < 3; i++) expect((await mail({ from: "loop@else.example", subject: `Ticket ${i}`, text: "x" })).action).toBe("ticket");
    expect(await mail({ from: "loop@else.example", subject: "Ticket 4", text: "x" })).toMatchObject({
      action: "ignored",
      reason: "more than 3 new tickets from loop@else.example in an hour",
    });
  });

  it("read the same email once", async () => {
    const { mail } = make();
    await mail({ ...gizem, id: "<same@avci.example>" });
    expect(await mail({ ...gizem, id: "<same@avci.example>" })).toEqual({ action: "duplicate" });
  });

  it("mark a reply that bounced, on its ticket", async () => {
    const { hd, mail, sender, support } = make();
    await mail(gizem);
    await hd.reply(EMILY, 1001, { text: "Hi" });
    const id = sender.sent[0]!.mail.messageId;
    const bounce = [
      "From: MAILER-DAEMON@mx.acme.example",
      "To: support@acme.example",
      "Subject: Undelivered Mail Returned to Sender",
      "Message-ID: <b1@mx.acme.example>",
      "X-Failed-Recipients: gizem@avci.example",
      "Content-Type: text/plain",
      "",
      `The message ${id} could not be delivered.`,
      "",
    ].join("\r\n");
    expect(await hd.ingestEmail(support, bounce)).toEqual({ action: "bounce", tickets: [1001] });
    const t = hd.detail(1001);
    expect(t.messages.find((m) => m.kind === "agent")!.delivery).toBe("failed");
    expect(t.messages.at(-1)).toMatchObject({ event: "bounce", data: { recipients: ["gizem@avci.example"] } });
  });

  it("acknowledge new requests at most once an hour to one address, as an automatic email", async () => {
    const { hd, mail, sender } = make({ settings: SETTINGS.replace("time_zone: Europe/Istanbul", "time_zone: Europe/Istanbul\n  acknowledge: true") });
    await mail({ ...gizem, id: "<g1@avci.example>" });
    await mail({ ...gizem, subject: "Another invoice question" });
    await hd.tick();
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.mail).toMatchObject({
      subject: "We have your request [#1001]",
      inReplyTo: "<g1@avci.example>",
      headers: { "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
    });
    expect(sender.sent[0]!.mail.text).toMatch(/^Hello Gizem,/);
  });
});

describe("closing and satisfaction", () => {
  it("asks the customer an hour after solving, and keeps the answer", async () => {
    const { hd, mail, sender, clock } = make();
    await mail(gizem);
    hd.update(EMILY, 1001, { status: "solved" });
    await hd.tick();
    expect(sender.sent).toHaveLength(0);
    clock.advance(H);
    await hd.tick();
    const ask = sender.sent[0]!.mail;
    expect(ask).toMatchObject({ subject: "How did we do? [#1001]", headers: { "Auto-Submitted": "auto-generated" } });
    const token = /\/r\/([A-Za-z0-9_-]+)\?score=5/.exec(ask.text)![1]!;
    hd.rate(token, 5, "Quick, thanks");
    const t = hd.detail(1001);
    expect(t.rating).toMatchObject({ score: 5, comment: "Quick, thanks" });
    expect(t.messages.at(-1)!.event).toBe("satisfaction");
    expect(() => hd.rate(token, 6, null)).toThrow(/score is 1 to 5/);
  });

  it("opens a new ticket for a reply after the reopen window, following the old one", async () => {
    const { hd, mail, sender, clock } = make();
    await mail(gizem);
    await hd.reply(EMILY, 1001, { text: "Done", status: "solved" });
    clock.advance(8 * 24 * H);
    await hd.tick();
    expect(hd.detail(1001).status).toBe("closed");
    const r = await mail({ from: gizem.from, subject: "Re: Invoices", text: "It is back", inReplyTo: sender.sent[0]!.mail.messageId });
    expect(r).toEqual({ action: "ticket", ticket: 1002 });
    expect(hd.detail(1002)).toMatchObject({ follows: 1001 });
  });
});

describe("forms and chats", () => {
  it("open a ticket from a form, once for the same external id", async () => {
    const { hd } = make();
    const body = {
      email: "Murat@Kilic.example",
      name: "Murat Kılıç",
      subject: "Wrong VAT rate on an export invoice",
      message: "See attached",
      form: "billing",
      fields: { "Invoice no": "A-1002" },
      external_id: "f-1",
    };
    const a = await hd.intake("forms", body, true);
    expect(a.created).toBe(true);
    const b = await hd.intake("forms", body, true);
    expect(b).toMatchObject({ created: false, ticket: { number: a.ticket.number } });
    const t = hd.detail(a.ticket.number);
    expect(t).toMatchObject({ channel: "form", queue: { id: "billing" }, customer: { email: "murat@kilic.example" }, address: "support@acme.example" });
    expect(t.messages[1]).toMatchObject({ kind: "customer", via: "form", data: { fields: { "Invoice no": "A-1002" } } });
  });

  it("take a chat's transcript, with the first reply done when an agent answered in the chat", async () => {
    const { hd } = make();
    const r = await hd.intake(
      "live-chat",
      {
        email: "okan@tekin.example",
        name: "Okan Tekin",
        external_id: "chat-9",
        transcript: [
          { from: "customer", text: "Can I pay by card?", at: "2026-11-02T11:50:00Z" },
          { from: "agent", name: "Elif Kaya", text: "Let me check with billing.", at: "2026-11-02T11:55:00Z" },
        ],
      },
      true,
    );
    const t = hd.detail(r.ticket.number);
    expect(t).toMatchObject({ subject: "Can I pay by card?", queue: { id: "sales" }, channel: "chat" });
    expect(t.clocks.firstReply!.state).toBe("met");
    expect(t.messages.filter((m) => m.via === "chat").map((m) => m.kind)).toEqual(["customer", "agent"]);
    const more = hd.intakeMessage("live-chat", r.ticket.number, { from: "customer", text: "Any news?" });
    expect(more.status).toBe("open");
    expect(() => hd.intakeMessage("forms", r.ticket.number, { text: "x" })).toThrow(/no ticket/);
  });

  it("say what is wrong with a post", async () => {
    const { hd } = make();
    await expect(hd.intake("forms", { message: "x" }, true)).rejects.toThrow("email is required.");
    await expect(hd.intake("forms", { email: "bad", message: "x" }, true)).rejects.toThrow("email is not an email address.");
    await expect(hd.intake("forms", { email: "a@b.example", message: "x", extra: 1 }, true)).rejects.toThrow("Unknown extra.");
    await expect(hd.intake("nope", {}, true)).rejects.toThrow(/no source nope/);
    await expect(hd.intake("contact", { email: "a@b.example", transcript: [{ from: "agent", text: "x" }] }, false)).rejects.toThrow(/source's key/);
  });
});

describe("the team's work", () => {
  it("assigns, sets priority, and lists tickets by the SLA that runs out first", async () => {
    const { hd, mail, clock } = make();
    await mail({ ...gizem, subject: "Hello" }); // general: first reply 1 day
    clock.advance(MIN);
    await mail(gizem); // billing: first reply 4 h
    expect(hd.list(new URLSearchParams({ status: "open" })).map((t) => t.number)).toEqual([1002, 1001]);
    expect(hd.assign(EMILY, { tickets: [1001, 1002], owner: "me" })).toEqual({ assigned: 2 });
    expect(hd.list(new URLSearchParams({ owner: EMILY.id })).length).toBe(2);
    hd.update(EMILY, 1001, { priority: "urgent" });
    expect(hd.detail(1001).priority).toBe("urgent");
    expect(hd.list(new URLSearchParams({ q: "#1002" })).map((t) => t.number)).toEqual([1002]);
    expect(hd.list(new URLSearchParams({ q: "hello" })).map((t) => t.number)).toEqual([1001]);
    expect(() => hd.update(EMILY, 1001, { owner: "nobody" })).toThrow(/member/);
  });

  it("keeps internal notes off the customer's email", async () => {
    const { hd, mail, sender } = make();
    await mail(gizem);
    const n = hd.note(EMILY, 1001, { text: "Three more customers report 1150." });
    expect(n.kind).toBe("note");
    expect(sender.sent).toHaveLength(0);
    expect(hd.detail(1001).status).toBe("open");
  });

  it("fills saved answers for the ticket", async () => {
    const { hd, mail } = make();
    await mail(gizem);
    const answers = hd.detail(1001, EMILY).answers;
    expect(answers.map((a) => a.id)).toEqual(["thanks", "gib"]);
    expect(answers[0]!.text).toBe("Hello Gizem, #1001 is solved. Emily Clark");
  });
});

describe("reports", () => {
  it("count tickets, times in working hours, SLAs met and missed, and satisfaction, by queue", async () => {
    const { hd, mail, clock, sender } = make();
    await mail(gizem); // 1001 billing
    clock.advance(30 * MIN);
    await hd.reply(EMILY, 1001, { text: "Fixed", status: "solved" });
    await mail({ from: "x@else.example", subject: "Invoice copy", text: "x" }); // 1002 billing, will miss
    clock.advance(30 * H);
    await hd.tick();
    const token = /\/r\/([A-Za-z0-9_-]+)\?/.exec(sender.sent.at(-1)!.mail.text)![1]!;
    hd.rate(token, 4, null);
    const r = hd.report(30);
    expect(r.totals).toMatchObject({ opened: 2, solved: 1, firstReply: 30 * MIN, solvedIn: 30 * MIN, slaMet: 2, slaMissed: 2, satisfaction: 4, answers: 1 });
    expect(r.byQueue.find((q) => q.id === "billing")).toMatchObject({ tickets: 2, slaMet: 2, slaMissed: 2, satisfaction: 4 });
    expect(r.byChannel).toEqual([
      { channel: "email", tickets: 2 },
      { channel: "form", tickets: 0 },
      { channel: "chat", tickets: 0 },
    ]);
    expect(r.series).toHaveLength(30);
    expect(r.series.find((d) => d.day === "2026-11-02")).toEqual({ day: "2026-11-02", opened: 2, solved: 1 });
    // Monday 15:00 in Istanbul.
    expect(r.arrivals[0]![15]).toBeGreaterThan(0);
  });
});
