import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CrmCustomer } from "./links.ts";
import { ADMIN_TOKEN, ENV, rawEmail, SITE, startApp } from "./test-app.ts";

// Contract tests (ADR 0024): every response the API sends must match openapi.json.

type Spec = {
  info: { version: string };
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: object }> }> }>>;
  components: { responses: Record<string, { content: Record<string, { schema: object }> }>; schemas: Record<string, object> };
};

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Spec;
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(spec, "openapi");

const docsDir = mkdtempSync(join(tmpdir(), "hd-docs-"));
writeFileSync(join(docsDir, "index.html"), "<!doctype html><title>API</title>");

const GIZEM: CrmCustomer = {
  contact: {
    id: "c-1",
    name: "Gizem Avcı",
    email: "gizem@avci.example",
    title: "Finance lead",
    company: { name: "Avcı Lojistik", users: 48 },
    plan: { id: "business", name: "Business", renews: "2026-12-31" },
    owner: { name: "Hakan Yıldız", email: null },
    url: "https://crm.acme.example/contacts/c-1",
  },
  deals: [{ id: "d-1", name: "Renewal and 20 more users", amount: 300000, currency: "TRY", stage: "Proposal", status: "open", url: null }],
};

let app: Awaited<ReturnType<typeof startApp>>;
let base: string;
const covered = new Set<string>();

beforeAll(async () => {
  app = await startApp({
    version,
    openapi: spec,
    docsDir,
    helpdesk: {
      crm: () => ({ lookup: async (email) => (email === "gizem@avci.example" ? GIZEM : null) }),
      kb: () => ({
        suggest: async () => [{ title: "Why GİB rejects an invoice", excerpt: "Code 1150", url: "https://kb.acme.example/help/en/articles/gib", helpful: 92 }],
      }),
    },
  });
  base = app.base;
  app.member("u-emily", "Emily Clark");
});

afterAll(() => app.close());

/** Calls the API and checks status, content type and body against the description. */
async function call(method: string, path: string, init: RequestInit = {}, concrete = path) {
  const res = await fetch(base + concrete, { redirect: "manual", ...init, method });
  const operation = spec.paths[path]?.[method.toLowerCase()];
  expect(operation, `${method} ${path} is not in openapi.json`).toBeDefined();
  covered.add(`${method} ${path}`);

  const declared = operation!.responses[String(res.status)];
  expect(declared, `${method} ${concrete} answered ${res.status}, which openapi.json does not list`).toBeDefined();
  const shared = declared!.$ref?.split("/").pop();
  const response = shared ? spec.components.responses[shared]! : declared!;
  const at = shared
    ? `openapi#/components/responses/${shared}`
    : `openapi#/paths/${path.replaceAll("/", "~1").replaceAll("{", "%7B").replaceAll("}", "%7D")}/${method.toLowerCase()}/responses/${res.status}`;

  if (!response.content) {
    expect(res.headers.get("content-length") ?? "0", `${method} ${path} ${res.status} should have no body`).toBe("0");
    return { res, body: undefined as any };
  }
  const type = res.headers.get("content-type")!.split(";")[0]!;
  expect(response.content?.[type], `${method} ${path} ${res.status} sent ${type}, which openapi.json does not list`).toBeDefined();

  const body = type.endsWith("json") ? await res.json() : await res.text();
  const schema = `${at}/content/${type.replace("/", "~1")}/schema`;
  const validate = ajv.getSchema(schema)!;
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  return { res, body: body as any };
}

const admin = (b?: unknown) => ({
  headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
  ...(b !== undefined && { body: typeof b === "string" ? b : JSON.stringify(b) }),
});
const key = (k: string, b?: unknown) => ({
  headers: { authorization: `Bearer ${k}`, "content-type": "application/json" },
  ...(b !== undefined && { body: JSON.stringify(b) }),
});

describe("openapi.json", () => {
  it("has the version of this release", () => {
    expect(spec.info.version).toBe(version);
  });

  it("is served with the running version", async () => {
    const served = (await (await fetch(`${base}/api/openapi.json`)).json()) as Spec;
    expect(served.info.version).toBe(version);
    expect(Object.keys(served.paths).filter((p) => !p.startsWith("/api/v1/auth/"))).toEqual(Object.keys(spec.paths));
    expect(served.paths["/api/v1/auth/login"]).toBeDefined();
  });

  it("serves the API reference at /api/docs/", async () => {
    expect((await fetch(`${base}/api/docs`, { redirect: "manual" })).headers.get("location")).toBe("/api/docs/");
    expect((await fetch(`${base}/api/docs/`)).headers.get("content-type")).toContain("text/html");
    expect((await fetch(`${base}/api/docs/../../package.json`)).status).not.toBe(200);
  });

  it("describes what CRM answers, and Helpdesk reads it that way", async () => {
    const validate = ajv.getSchema("openapi#/components/schemas/CrmLookup")!;
    expect(validate(GIZEM), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe("responses match openapi.json", () => {
  it("product and health", async () => {
    await call("GET", "/api/v1/version");
    await call("GET", "/api/v1/products", admin());
    await call("GET", "/api/v1/products", {});
    await call("GET", "/api/v1/settings", admin());
    await call("GET", "/api/v1/team", admin());
    await call("GET", "/api/v1/mail", admin());
    await call("POST", "/api/v1/mail/check", admin());
    await call("POST", "/api/v1/mail/check", {});
    await call("GET", "/healthz");
    await call("GET", "/readyz");
    await call("GET", "/metrics");
  });

  it("public tickets", async () => {
    await call(
      "POST",
      "/api/v1/public/tickets",
      key(ENV.HD_FORMS_KEY, { email: "murat@kilic.example", name: "Murat Kılıç", subject: "Wrong VAT rate", message: "Export invoice", external_id: "f1" }),
    );
    await call("POST", "/api/v1/public/tickets", key(ENV.HD_FORMS_KEY, { email: "murat@kilic.example", message: "Export invoice", external_id: "f1" }));
    await call("POST", "/api/v1/public/tickets", key("wrong-key", { message: "x" }));
    await call("POST", "/api/v1/public/tickets", key(ENV.HD_FORMS_KEY, { message: "no email" }));
    await call("POST", "/api/v1/public/tickets", key(ENV.HD_FORMS_KEY, "{" as never));
    await call("POST", "/api/v1/public/tickets", {
      headers: { origin: SITE, "content-type": "application/json" },
      body: JSON.stringify({ source: "contact", email: "a@b.example", message: "Hi" }),
    });
    await call("POST", "/api/v1/public/tickets", {
      headers: { origin: SITE, "content-type": "application/json" },
      body: JSON.stringify({ source: "contact", email: "a@b.example", message: "Hi", website: "spam" }),
    });
    await call("POST", "/api/v1/public/tickets", {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ source: "contact", message: "x" }),
    });
    await call("POST", "/api/v1/public/tickets", { headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "nope" }) });
    await call("POST", "/api/v1/public/tickets", {
      headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ source: "contact", email: "c@d.example", message: "From a plain form", "fields[Order]": "42" }).toString(),
    });
    await call("POST", "/api/v1/public/tickets", {
      headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ source: "contact", email: "c@d.example", message: "Again", redirect: `${SITE}/thanks` }).toString(),
    });
    const chat = await call("POST", "/api/v1/public/tickets", key(ENV.HD_CHAT_KEY, { transcript: [{ from: "customer", text: "Can I pay by card?" }] }));
    const n = chat.body.ticket.number;
    await call("POST", "/api/v1/public/tickets/{number}/messages", key(ENV.HD_CHAT_KEY, { text: "Hello?" }), `/api/v1/public/tickets/${n}/messages`);
    await call("POST", "/api/v1/public/tickets/{number}/messages", key(ENV.HD_FORMS_KEY, { text: "x" }), `/api/v1/public/tickets/${n}/messages`);
    await call("POST", "/api/v1/public/tickets/{number}/messages", { body: "{}" }, `/api/v1/public/tickets/${n}/messages`);
    await call("POST", "/api/v1/public/tickets/{number}/messages", key(ENV.HD_CHAT_KEY, { text: "" }), `/api/v1/public/tickets/${n}/messages`);
  });

  it("tickets", async () => {
    const r = await app.hd.ingestEmail(
      app.hd.config()!.addresses[0]!,
      rawEmail({ from: "Gizem Avcı <gizem@avci.example>", subject: "Invoices fail to send", text: "Code 1150", id: "<g1@avci.example>" }),
    );
    const n = (r as { ticket: number }).ticket;
    await call("GET", "/api/v1/tickets", admin());
    await call("GET", "/api/v1/tickets", admin(), "/api/v1/tickets?status=open&queue=billing&q=invoice");
    await call("GET", "/api/v1/tickets", admin(), "/api/v1/tickets?status=gone");
    await call("GET", "/api/v1/tickets", {});
    await call("GET", "/api/v1/tickets/{number}", admin(), `/api/v1/tickets/${n}`);
    await call("GET", "/api/v1/tickets/{number}", admin(), "/api/v1/tickets/99999");
    await call("GET", "/api/v1/tickets/{number}/customer", admin(), `/api/v1/tickets/${n}/customer`);
    await call("GET", "/api/v1/tickets/{number}/articles", admin(), `/api/v1/tickets/${n}/articles`);
    await call("PATCH", "/api/v1/tickets/{number}", admin({ owner: "u-emily", priority: "high" }), `/api/v1/tickets/${n}`);
    await call("PATCH", "/api/v1/tickets/{number}", admin({ queue: "nowhere" }), `/api/v1/tickets/${n}`);
    await call("PATCH", "/api/v1/tickets/{number}", admin({ owner: "u-emily" }), "/api/v1/tickets/99999");
    await call("POST", "/api/v1/tickets/{number}/notes", admin({ text: "Integrator renewed its certificate." }), `/api/v1/tickets/${n}/notes`);
    await call("POST", "/api/v1/tickets/{number}/notes", admin({ text: "" }), `/api/v1/tickets/${n}/notes`);
    const reply = await call(
      "POST",
      "/api/v1/tickets/{number}/replies",
      admin({
        text: "Please send again.",
        attachments: [{ name: "steps.txt", type: "text/plain", data: Buffer.from("1. Invoices\n2. Send again").toString("base64") }],
      }),
      `/api/v1/tickets/${n}/replies`,
    );
    expect(reply.body.delivery).toBe("sent");
    await call("POST", "/api/v1/tickets/{number}/replies", admin("{"), `/api/v1/tickets/${n}/replies`);
    const chat = (await app.hd.intake("live-chat", { transcript: [{ from: "customer", text: "Hi" }] }, true)).ticket.number;
    await call("POST", "/api/v1/tickets/{number}/replies", admin({ text: "Hello" }), `/api/v1/tickets/${chat}/replies`);
    await call("POST", "/api/v1/tickets/assign", admin({ tickets: [n, chat], owner: "u-emily" }));
    await call("POST", "/api/v1/tickets/assign", admin({ tickets: [99999], owner: null }));
    await call("POST", "/api/v1/tickets/assign", admin({ tickets: "x" }));
    const att = app.hd.detail(n).messages.find((m) => m.attachments.length)!.attachments[0]!;
    await call("GET", "/api/v1/attachments/{id}", admin(), `/api/v1/attachments/${att.id}`);
    await call("GET", "/api/v1/attachments/{id}", admin(), "/api/v1/attachments/missing");
    await call("PATCH", "/api/v1/tickets/{number}", admin({ status: "solved" }), `/api/v1/tickets/${n}`);
  });

  it("satisfaction", async () => {
    const t = app.hd.list(new URLSearchParams({ status: "solved" }))[0]!;
    app.clock.advance(2 * 3_600_000);
    await app.hd.tick();
    const ask = app.sender.sent.find((s) => s.mail.subject.startsWith("How did we do?"))!.mail;
    const token = new RegExp(`/r/([A-Za-z0-9_-]+)\\?score=5`).exec(ask.text)![1]!;
    await call("GET", "/r/{token}", {}, `/r/${token}?score=5`);
    await call("POST", "/r/{token}", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "score=5&comment=Quick" }, `/r/${token}`);
    await call("POST", "/r/{token}", { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "comment=none" }, `/r/${token}`);
    await call("GET", "/r/{token}", {}, "/r/not-a-real-token-at-all-0123");
    expect(app.hd.detail(t.number).rating?.score).toBe(5);
  });

  it("reports", async () => {
    await call("GET", "/api/v1/overview", admin());
    await call("GET", "/api/v1/overview", {});
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?days=30");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?days=7");
    await call("GET", "/api/v1/report", admin(), "/api/v1/report?days=2");
  });

  it("covers every operation in openapi.json", () => {
    const all = Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`));
    expect([...covered].sort()).toEqual(all.sort());
  });
});
