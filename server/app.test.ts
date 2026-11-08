import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENV, rawEmail, SITE, startApp } from "./test-app.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
let app: Awaited<ReturnType<typeof startApp>>;

beforeAll(async () => {
  app = await startApp({ version });
  app.member("u-emily", "Emily Clark");
});
afterAll(() => app.close());

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(app.base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("the public ticket API", () => {
  it("lets pages on the source's origins read the answer, and no others", async () => {
    const pre = await fetch(`${app.base}/api/v1/public/tickets`, { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(SITE);
    const evil = await fetch(`${app.base}/api/v1/public/tickets`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const res = await post(
      "/api/v1/public/tickets",
      { source: "contact", email: "seda@polat.example", subject: "Bank connection", message: "Garanti BBVA fails" },
      { origin: SITE },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    const body = (await res.json()) as { ticket: { number: number; reference: string; status: string } };
    expect(body.ticket).toEqual({ number: body.ticket.number, reference: `#${body.ticket.number}`, status: "open" });
    // What a browser gets back says nothing about the team.
    expect(Object.keys(body.ticket)).toEqual(["number", "reference", "status"]);
  });

  it("takes a source's key from a server, but not another source's", async () => {
    expect((await post("/api/v1/public/tickets", { email: "a@b.example", message: "x" }, { authorization: `Bearer ${ENV.HD_FORMS_KEY}` })).status).toBe(201);
    expect((await post("/api/v1/public/tickets", { source: "live-chat", message: "x" }, { authorization: `Bearer ${ENV.HD_FORMS_KEY}` })).status).toBe(422);
    // A page cannot post to a source that has only a key.
    expect((await post("/api/v1/public/tickets", { source: "forms", email: "a@b.example", message: "x" }, { origin: SITE })).status).toBe(403);
  });

  it("thanks a plain HTML form, or sends it on to the page it names", async () => {
    const form = (extra: Record<string, string>) =>
      fetch(`${app.base}/api/v1/public/tickets`, {
        method: "POST",
        redirect: "manual",
        headers: { origin: SITE, "content-type": "application/x-www-form-urlencoded", "accept-language": "tr" },
        body: new URLSearchParams({ source: "contact", email: "hakan@yildiz.example", message: "Plan change", ...extra }).toString(),
      });
    const redirected = await form({ redirect: `${SITE}/thanks`, "fields[Plan]": "Business" });
    expect(redirected.status).toBe(303);
    expect(redirected.headers.get("location")).toMatch(new RegExp(`^${SITE}/thanks\\?ticket=\\d+$`));
  });
  it("limits a browser's posts from one address", async () => {
    let last = 0;
    for (let i = 0; i < 12; i++)
      last = (await post("/api/v1/public/tickets", { source: "contact", email: `r${i}@b.example`, message: "x" }, { origin: SITE })).status;
    expect(last).toBe(429);
  });
});

describe("pages and files", () => {
  it("serves attachments so nothing in them runs here", async () => {
    const hd = app.hd;
    const raw = [
      "From: x@customer.example",
      "To: support@acme.example",
      "Subject: With files",
      "Message-ID: <files@customer.example>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="m"',
      "",
      "--m",
      "Content-Type: text/plain",
      "",
      "See attached",
      "--m",
      'Content-Type: text/html; name="page.html"',
      'Content-Disposition: attachment; filename="page.html"',
      "",
      "<script>alert(1)</script>",
      "--m",
      'Content-Type: image/png; name="shot.png"',
      'Content-Disposition: attachment; filename="shot.png"',
      "Content-Transfer-Encoding: base64",
      "",
      "iVBORw0KGgo=",
      "--m--",
      "",
    ].join("\r\n");
    const r = (await hd.ingestEmail(hd.config()!.addresses[0]!, raw)) as { ticket: number };
    const files = hd.detail(r.ticket).messages.find((m) => m.kind === "customer")!.attachments;
    const page = await app.admin(`/api/v1/attachments/${files.find((f) => f.filename === "page.html")!.id}`);
    expect(page.headers.get("content-type")).toBe("application/octet-stream");
    expect(page.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''page.html");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    const image = await app.admin(`/api/v1/attachments/${files.find((f) => f.filename === "shot.png")!.id}`);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toMatch(/^inline/);
  });

  it("keeps a satisfaction answer only when it is sent, not when the link is opened", async () => {
    const hd = app.hd;
    const r = (await hd.ingestEmail(hd.config()!.addresses[0]!, rawEmail({ from: "kerem@aksoy.example", subject: "Charged twice", text: "x" }))) as {
      ticket: number;
    };
    hd.update({ id: "u-emily", name: "Emily Clark" }, r.ticket, { status: "solved" });
    app.clock.advance(2 * 3_600_000);
    await hd.tick();
    const ask = app.sender.sent.findLast((s) => s.mail.subject === `How did we do? [#${r.ticket}]`)!.mail;
    const link = /(\/r\/[A-Za-z0-9_-]+)\?score=1/.exec(ask.text)![1]!;
    const page = await fetch(`${app.base}${link}?score=1`, { headers: { "accept-language": "de" } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain("Wie zufrieden waren Sie?");
    expect(html).toContain('value="1" required checked');
    expect(hd.detail(r.ticket).rating?.score).toBeNull();
    const sent = await fetch(`${app.base}${link}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "score=2&comment=Slow",
    });
    expect(await sent.text()).toContain("Thank you.");
    expect(hd.detail(r.ticket).rating).toMatchObject({ score: 2, comment: "Slow" });
  });

  it("answers health, readiness and metrics", async () => {
    expect((await fetch(`${app.base}/healthz`)).status).toBe(200);
    expect((await fetch(`${app.base}/readyz`)).status).toBe(200);
    const metrics = await (await fetch(`${app.base}/metrics`)).text();
    expect(metrics).toContain(`openasy_build_info{product="helpdesk",version="${version}"} 1`);
    expect(metrics).toMatch(/openasy_helpdesk_tickets\{status="open"\} \d+/);
    expect(metrics).toContain("openasy_helpdesk_sla_missed");
    expect((await fetch(`${app.base}/api/v1/version`)).headers.get("content-security-policy")).toContain("img-src 'self' data:");
  });
});
