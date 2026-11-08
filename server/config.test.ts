import { mkdtempSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configWarnings, parseConfig, parseDuration, watchConfig } from "./config.ts";
import { route, targetsFor } from "./routing.ts";
import { SETTINGS } from "./test-app.ts";

const H = 3_600_000;

describe("the settings file", () => {
  it("starts with one queue and no addresses when there is no file", () => {
    const c = parseConfig("");
    expect(c.queues.map((q) => q.id)).toEqual(["general"]);
    expect(c.addresses).toEqual([]);
    expect(c.support).toMatchObject({ name: "Support", language: "en", timeZone: "UTC", acknowledge: false, maxNewPerHour: 10 });
    expect(c.satisfaction.askAfter).toBe(H);
  });

  it("reads the example file in config/", () => {
    const c = parseConfig(readFileSync(new URL("../config/helpdesk.yaml", import.meta.url), "utf8"));
    expect(c.queues.map((q) => q.id)).toEqual(["billing", "technical", "sales", "it", "general"]);
    expect(c.addresses.map((a) => a.address)).toEqual(["support@example.com", "it@example.com"]);
    expect(c.addresses[1]).toMatchObject({ password: "HELPDESK_IT_PASSWORD", imap: { host: "mail.example.com", port: 993, tls: true } });
    expect(c.sources.map((s) => [s.id, s.channel])).toEqual([
      ["forms", "form"],
      ["live-chat", "chat"],
      ["contact-page", "form"],
    ]);
  });

  it("reads queues, their hours and their SLAs, with days as working days", () => {
    const c = parseConfig(SETTINGS);
    const billing = c.queues[0]!;
    expect(billing.sla.firstReply).toEqual({ ms: 4 * H, text: "4h" });
    // weekdays 09:00-18:00: one working day is nine hours.
    expect(billing.sla.solution).toEqual({ ms: 9 * H, text: "1d" });
    expect(billing.slaByPlan.business).toEqual({ firstReply: { ms: 2 * H, text: "2h" } });
    expect(targetsFor(billing, "Business")).toEqual({ firstReply: 2 * H, solution: 9 * H });
    expect(targetsFor(billing, null)).toEqual({ firstReply: 4 * H, solution: 9 * H });
    // Round the clock, a day is 24 hours.
    expect(c.queues.find((q) => q.id === "it")!.sla.solution!.ms).toBe(72 * H);
    expect(c.queues.find((q) => q.id === "it")!.sla.firstReply).toBeNull();
  });

  it("reads durations", () => {
    expect(parseDuration("1d 4h", "x")).toMatchObject({ days: 1, minutes: 240 });
    expect(parseDuration("2h30m", "x")).toMatchObject({ days: 0, minutes: 150 });
    expect(parseDuration(45, "x")).toMatchObject({ minutes: 45 });
    expect(() => parseDuration("soon", "sla.first_reply")).toThrow("sla.first_reply is a duration");
    expect(() => parseDuration("0m", "x")).toThrow(/more than nothing/);
  });

  it("names the field to fix", () => {
    const bad: Array<[string, RegExp]> = [
      ["nonsense: 1", /The file: unknown nonsense/],
      ["queues: { Billing: {} }", /queues.Billing: a queue id/],
      ["queues: { b: { sla: { first_reply: soon } } }", /queues.b.sla.first_reply is a duration/],
      ["queues: { b: { match: { address: x@example.com } } }", /x@example.com is not one of the addresses/],
      ["queues: { b: { match: { channel: phone } } }", /channel\[0\] is email, form, chat/],
      ["queues: { b: { hours: nights } }", /queues.b.hours is always/],
      ["queues: { b: { time_zone: Mars/Base } }", /not a time zone/],
      ["addresses: [not-an-address]", /addresses\[0\] is an email address/],
      ["addresses: [a@example.com, A@example.com]", /in the file twice/],
      ["mail: { password: hunter2 }", /mail.password is the name of an environment variable/],
      ["sources: { forms: { channel: form } }", /needs a key/],
      ["sources: { forms: { key: K, origins: [http://shop.example] } }", /https:\/\//],
      ["crm: { url: http://crm.example.com }", /crm.url is an https/],
      ["answers: [{ id: a, title: A, text: x, queues: [nope] }]", /nope is not one of the queues/],
      ["support: { language: fr }", /support.language is en, de, tr/],
      ["key: [", /Not valid YAML/],
    ];
    for (const [yaml, error] of bad) expect(() => parseConfig(yaml), yaml).toThrow(error);
  });

  it("allows http only inside the install", () => {
    expect(parseConfig("crm: { url: http://crm:8080 }").crm).toEqual({ url: "http://crm:8080", token: "HELPDESK_CRM_TOKEN" });
    expect(parseConfig("knowledge_base: { url: https://kb.example.com/ }").knowledgeBase).toEqual({ url: "https://kb.example.com", language: null });
  });

  it("warns about secrets that are not set and queues that leave tickets out", () => {
    const c = parseConfig("addresses: [a@example.com]\nmail: { imap: imap.example.com }\nqueues: { b: { match: { channel: chat } } }");
    expect(configWarnings(c, {})).toEqual([
      "a@example.com: HELPDESK_MAIL_PASSWORD is not set, so its mail cannot be read or sent.",
      "a@example.com: no SMTP server (mail.smtp), so replies cannot be sent from it.",
      "No queue catches every ticket: tickets no rule matches go to the last queue.",
    ]);
  });

  it("keeps the last good file when a change has a mistake", () => {
    const dir = mkdtempSync(join(tmpdir(), "hd-config-"));
    const path = join(dir, "helpdesk.yaml");
    writeFileSync(path, "support: { name: First }");
    const applied: string[] = [];
    const w = watchConfig(path, (c) => (applied.push(c.support.name), []), { everyMs: 60_000 });
    writeFileSync(path, "support: { name: [ }");
    w.read();
    expect(w.state.error).toMatch(/Not valid YAML/);
    writeFileSync(path, "support: { name: Second }");
    w.read();
    w.stop();
    expect(applied).toEqual(["First", "Second"]);
    expect(w.state.error).toBeNull();
  });
});

describe("routing", () => {
  const c = parseConfig(SETTINGS);
  const arrival = {
    channel: "email" as const,
    address: "support@acme.example",
    source: null,
    form: null,
    subject: "",
    fromEmail: "a@customer.example",
    plan: null,
  };

  it("sends a ticket to the first queue whose rule matches, and says why", () => {
    expect(route(c, { ...arrival, subject: "Faturalar gitmiyor" })).toMatchObject({ queue: { id: "billing" }, rule: 'subject has "fatura"' });
    expect(route(c, { ...arrival, subject: "FATURA" }).queue.id).toBe("billing");
    expect(route(c, { ...arrival, subject: "Invoices fail to send" }).rule).toBe('subject has "invoice"');
    expect(route(c, { ...arrival, subject: "Hello", plan: "business" })).toMatchObject({ queue: { id: "billing" }, rule: "plan business", firstReply: 2 * H });
    expect(route(c, { ...arrival, channel: "chat", source: "live-chat", address: null, subject: "Hi" })).toMatchObject({
      queue: { id: "sales" },
      rule: "channel chat",
    });
    expect(route(c, { ...arrival, address: "it@acme.example", subject: "Laptop" })).toMatchObject({ queue: { id: "it" }, rule: "address it@acme.example" });
    expect(route(c, { ...arrival, subject: "Hello" })).toMatchObject({ queue: { id: "general" }, rule: "every ticket" });
  });

  it("matches words from their start, not inside other words", () => {
    expect(route(c, { ...arrival, subject: "Reinvoiced twice" }).queue.id).toBe("general");
  });

  it("gives tickets no rule matches to the last queue", () => {
    const strict = parseConfig("queues: { a: { match: { channel: chat } }, b: { match: { channel: form } } }");
    expect(route(strict, arrival)).toMatchObject({ queue: { id: "b" }, rule: "no rule matched" });
  });

  it("needs every condition of a rule", () => {
    const both = parseConfig("queues: { vip: { match: { channel: form, from_domain: bigcorp.example } }, other: {} }");
    expect(route(both, { ...arrival, channel: "form", fromEmail: "x@eu.bigcorp.example" })).toMatchObject({
      queue: { id: "vip" },
      rule: "channel form, from bigcorp.example",
    });
    expect(route(both, { ...arrival, channel: "email", fromEmail: "x@bigcorp.example" }).queue.id).toBe("other");
  });
});
