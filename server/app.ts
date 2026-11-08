import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { AuthError, identityOrigin, mergeOpenApi, sendProblem, type Auth, type Role } from "@openasy/auth";
import type { Source } from "./config.ts";
import { HdError, parseRange, type Actor, type Helpdesk, type ProblemCode } from "./helpdesk.ts";
import { log } from "./log.ts";
import { countRequest, renderMetrics } from "./metrics.ts";
import type { ProductLink } from "./products.ts";
import { negotiate, words, type WordKey } from "./words.ts";

export interface AppOptions {
  db: DatabaseSync;
  hd: Helpdesk;
  version: string;
  /** The address people open the product at. */
  publicUrl: string;
  /** Sign-in, sessions, members and API tokens (ADR 0002, 0003). */
  auth: Auth;
  /** The environment the sources' keys are read from. */
  env?: Record<string, string | undefined>;
  /** For tests and local scripts: one shared token with the admin role. main.ts never sets it. */
  adminToken?: string;
  /** Built web UI; omit to run headless (ADR 0018). */
  webDir?: string;
  /** Built API reference (Swagger UI), served at /api/docs. */
  docsDir?: string;
  /** The OpenAPI description, served at /api/openapi.json with this release's version. */
  openapi?: Record<string, unknown>;
  /** false when /metrics is served on its own port instead (ADR 0026). */
  serveMetrics?: boolean;
  /** The install's OpenAsy products and their addresses, from OPENASY_PRODUCTS, for the product switcher. */
  products?: ProductLink[];
}

function metricsText(hd: Helpdesk, version: string) {
  return renderMetrics(version, { ...hd.gauges(), fileError: !!hd.settings().file?.error });
}

/** Serves only /metrics, for a port that is not exposed with the rest (HELPDESK_METRICS_PORT). */
export function createMetricsHandler(hd: Helpdesk, version: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/metrics") return problem(res, 404, "not-found");
    send(res, 200, metricsText(hd, version), "text/plain; version=0.0.4");
  };
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

// Identity keeps people's theme and language when they sign in through it; the pages read them there (ADR 0033).
const IDENTITY = identityOrigin(process.env);

/** The team's pages run nothing from elsewhere, and show no image from elsewhere: emails' remote images are removed. */
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy": `default-src 'self'; connect-src 'self'${IDENTITY ? ` ${IDENTITY}` : ""}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'none'; form-action 'self'`,
};

/** The customer's pages: no script at all. */
const PAGE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res: ServerResponse, status: number, body: string | Buffer, type = "application/json", headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, "content-type": type, "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown, headers?: Record<string, string>) =>
  send(res, status, JSON.stringify(data), "application/json", headers);

const TITLES: Record<ProblemCode, string> = {
  "invalid-token": "Invalid token",
  "invalid-json": "Invalid JSON",
  "invalid-body": "Invalid request body",
  "forbidden-origin": "Origin not allowed",
  "not-found": "Not found",
  conflict: "Conflict",
  "rate-limited": "Too many requests",
  "payload-too-large": "Payload too large",
  unavailable: "Not available yet",
  "internal-error": "Internal error",
};

/** RFC 9457 Problem Details (ADR 0024). `code` is the stable part clients match on. */
function problem(res: ServerResponse, status: number, code: ProblemCode, detail?: string, headers: Record<string, string> = {}) {
  const body = { type: `https://openasy.github.io/problems/${code}`, title: TITLES[code], status, code, ...(detail && { detail }) };
  send(res, status, JSON.stringify(body), "application/problem+json", headers);
}

/** Serves a file from dir, or returns false when the path is outside it or missing. */
async function serveFile(res: ServerResponse, dir: string, relative: string): Promise<boolean> {
  const file = normalize(join(dir, relative));
  if (!file.startsWith(normalize(dir)) || !extname(file)) return false;
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? "application/octet-stream");
    return true;
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new HdError(413, "payload-too-large", `The body must be at most ${Math.round(limit / 1024)} KiB.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a JSON body of up to `limit` bytes. */
async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HdError(400, "invalid-json", "The body must be JSON.");
  }
}

function tokenMatches(header: string | undefined, expected: string | undefined): boolean {
  if (!expected || !header?.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** A small page for customers: the satisfaction question, or the thanks after a form. */
function page(lang: string, title: string, body: string) {
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--bg:#fff;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--bg:#0d1117}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:34rem;margin:3rem auto;padding:0 1rem}h1{font-size:1.5rem;margin:0 0 .5rem}p{margin:.5rem 0}.muted{color:var(--muted);font-size:.9rem}
fieldset{border:0;padding:0;margin:1rem 0;display:flex;flex-wrap:wrap;gap:.5rem}legend{font-weight:600;margin-bottom:.5rem}
label.score{display:flex;align-items:center;gap:.35rem;border:1px solid var(--line);border-radius:.5rem;padding:.45rem .7rem;cursor:pointer}
textarea{width:100%;box-sizing:border-box;min-height:6rem;font:inherit;padding:.5rem;border:1px solid var(--line);border-radius:.5rem;background:var(--bg);color:var(--fg)}
button{font:inherit;margin-top:.75rem;padding:.55rem 1.1rem;border:0;border-radius:.5rem;background:var(--accent);color:#fff;cursor:pointer}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
</style>
</head>
<body><main>
${body}
</main></body>
</html>
`;
}

/** The role a route needs (ADR 0003); "none" for the version. */
type Access = "none" | Role;
interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  who: Actor;
  body: () => Promise<unknown>;
}
interface Route {
  method: string;
  /** Path pattern; each `:name` matches one segment. */
  path: string;
  auth: Access;
  /** Largest JSON body taken, in bytes. Default 1 MiB. */
  limit?: number;
  handle: (ctx: Ctx) => unknown;
}

/** Tickets a minute from one address with no key: a browser's form. Counted in memory, never stored. */
const PUBLIC_RATE = 10;

export function createApp({ db, hd, version, auth, env = process.env, adminToken, webDir, docsDir, openapi, serveMetrics = true, products = [] }: AppOptions) {
  // The served description includes /api/v1/auth from @openasy/auth, so the API reference documents sign-in too.
  const spec = openapi && JSON.stringify({ ...mergeOpenApi(openapi), info: { ...(openapi.info as object), version } });
  const num = (s: string) => {
    const n = Number(s.replace(/^#/, ""));
    if (!Number.isInteger(n) || n < 1) throw new HdError(404, "not-found", `There is no ticket ${s}.`);
    return n;
  };

  const routes: Route[] = [
    { method: "GET", path: "/api/v1/version", auth: "none", handle: () => ({ product: "helpdesk", version }) },
    { method: "GET", path: "/api/v1/products", auth: "viewer", handle: () => ({ products }) },
    { method: "GET", path: "/api/v1/overview", auth: "viewer", handle: () => hd.overview() },
    // The settings, as the file sets them. There is no route that changes them.
    { method: "GET", path: "/api/v1/settings", auth: "viewer", handle: () => hd.settings() },
    { method: "GET", path: "/api/v1/team", auth: "viewer", handle: () => ({ members: hd.team() }) },
    { method: "GET", path: "/api/v1/mail", auth: "viewer", handle: () => hd.mail() },
    { method: "POST", path: "/api/v1/mail/check", auth: "admin", handle: async () => (await hd.checkMail(true), await hd.tick(), hd.mail()) },

    { method: "GET", path: "/api/v1/tickets", auth: "viewer", handle: ({ url }) => ({ tickets: hd.list(url.searchParams) }) },
    { method: "POST", path: "/api/v1/tickets/assign", auth: "editor", handle: async ({ who, body }) => hd.assign(who, await body()) },
    { method: "GET", path: "/api/v1/tickets/:number", auth: "viewer", handle: ({ who, params }) => hd.detail(num(params[0]!), who) },
    {
      method: "PATCH",
      path: "/api/v1/tickets/:number",
      auth: "editor",
      handle: async ({ who, params, body }) => hd.update(who, num(params[0]!), await body()),
    },
    {
      method: "POST",
      path: "/api/v1/tickets/:number/replies",
      auth: "editor",
      limit: 40 * 1024 * 1024,
      handle: async ({ res, who, params, body }) => json(res, 201, await hd.reply(who, num(params[0]!), await body())),
    },
    {
      method: "POST",
      path: "/api/v1/tickets/:number/notes",
      auth: "editor",
      handle: async ({ res, who, params, body }) => json(res, 201, hd.note(who, num(params[0]!), await body())),
    },
    { method: "GET", path: "/api/v1/tickets/:number/customer", auth: "viewer", handle: ({ params }) => hd.customer(num(params[0]!)) },
    { method: "GET", path: "/api/v1/tickets/:number/articles", auth: "viewer", handle: ({ params }) => hd.articles(num(params[0]!)) },
    {
      method: "GET",
      path: "/api/v1/attachments/:id",
      auth: "viewer",
      handle: ({ res, params }) => {
        const a = hd.attachment(params[0]!);
        // Only plain image types are shown in the page; anything else is downloaded, and nothing in it can run here.
        const inline = /^image\/(png|jpeg|gif|webp)$/i.test(a.contentType);
        send(res, 200, a.data, inline ? a.contentType : "application/octet-stream", {
          "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "private, max-age=3600",
        });
      },
    },
    { method: "GET", path: "/api/v1/report", auth: "viewer", handle: ({ url }) => hd.report(parseRange(url.searchParams.get("days"))) },
  ];

  const compiled = routes.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:[a-z]+/g, "([^/]+)")}$`) }));

  // ------------------------------------------------------------------ the public ticket API: Forms, Live Chat, sites

  /** The source whose key the request carries, if any. */
  function keyed(req: IncomingMessage): Source | null {
    for (const s of hd.config()?.sources ?? []) if (s.key && tokenMatches(req.headers.authorization, env[s.key])) return s;
    return null;
  }
  const originSources = (origin: string | undefined) => (origin ? (hd.config()?.sources ?? []).filter((s) => s.origins.includes(origin)) : []);
  const cors = (req: IncomingMessage): Record<string, string> =>
    originSources(req.headers.origin).length ? { "access-control-allow-origin": req.headers.origin!, vary: "Origin" } : { vary: "Origin" };

  const hits = new Map<string, { minute: number; n: number }>();
  function limited(req: IncomingMessage): boolean {
    const key = req.socket.remoteAddress ?? "";
    const minute = Math.floor(Date.now() / 60_000);
    const h = hits.get(key);
    if (!h || h.minute !== minute) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { minute, n: 1 });
      return false;
    }
    return ++h.n > PUBLIC_RATE;
  }

  const lang = (req: IncomingMessage) => negotiate(req.headers["accept-language"], hd.config()?.support.language ?? "en");

  async function publicTicket(req: IncomingMessage, res: ServerResponse) {
    const headers = { ...cors(req), "cache-control": "no-store" };
    const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const isForm = type === "application/x-www-form-urlencoded";
    let redirect: string | null = null;
    try {
      const source = keyed(req);
      if (req.headers.authorization && !source) throw new HdError(401, "invalid-token", "The key is not one of the sources' keys.");
      let body: unknown;
      if (isForm) {
        const form = new URLSearchParams(await readBody(req, 256 * 1024));
        const fields: Record<string, string> = {};
        const b: Record<string, unknown> = {};
        for (const [k, v] of form) {
          if (["source", "form", "email", "name", "subject", "message", "language", "external_id", "website", "redirect"].includes(k)) b[k] = v;
          else if (k.startsWith("fields[") && k.endsWith("]")) fields[k.slice(7, -1)] = v;
        }
        if (Object.keys(fields).length) b.fields = fields;
        body = b;
      } else body = await readJson(req, 4 * 1024 * 1024);
      const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
      const sourceId = source?.id ?? (typeof b.source === "string" ? b.source : "");
      if (source && b.source !== undefined && b.source !== source.id) throw new HdError(422, "invalid-body", `This key is the source ${source.id}'s.`);
      const named = hd.config()?.sources.find((s) => s.id === sourceId);
      if (!named) throw new HdError(404, "not-found", `There is no source ${sourceId || "(none given)"} in the settings file.`);
      if (!source) {
        // A browser: its page must be on one of the source's origins, and it is limited per address.
        const origin = req.headers.origin;
        if (!origin || !named.origins.includes(origin)) throw new HdError(403, "forbidden-origin", `This page's origin is not in sources.${named.id}.origins.`);
        if (limited(req)) throw new HdError(429, "rate-limited", "Too many requests from this address; wait a minute.", 60);
      }
      if (typeof b.redirect === "string") {
        const r = URL.parse(b.redirect);
        if (r && named.origins.includes(r.origin)) redirect = r.href;
      }
      delete b.redirect;
      delete b.source;
      // A filled hidden field: a bot. It is told it worked and nothing is opened.
      if (typeof b.website === "string" && b.website.trim()) {
        if (redirect) return void res.writeHead(303, { ...headers, location: redirect }).end();
        if (isForm) return void send(res, 200, thanks(req, 0), "text/html; charset=utf-8", { ...PAGE_HEADERS, ...headers });
        return json(res, 202, { ticket: null, created: false }, headers);
      }
      delete b.website;
      const r = await hd.intake(named.id, b, !!source);
      const out = { ticket: { number: r.ticket.number, reference: `#${r.ticket.number}`, status: r.ticket.status }, created: r.created };
      if (isForm) {
        if (redirect) {
          const to = new URL(redirect);
          to.searchParams.set("ticket", String(r.ticket.number));
          return void res.writeHead(303, { ...headers, location: to.href }).end();
        }
        return void send(res, 201, thanks(req, r.ticket.number), "text/html; charset=utf-8", { ...PAGE_HEADERS, ...headers });
      }
      json(res, r.created ? 201 : 200, out, headers);
    } catch (err) {
      if (!(err instanceof HdError)) throw err;
      if (!req.complete) req.resume();
      if (isForm && err.status < 500) {
        const t = words(lang(req));
        return void send(
          res,
          err.status,
          page(lang(req), t("formFailed"), `<h1>${esc(t("formFailed"))}</h1><p>${esc(err.message)}</p>`),
          "text/html; charset=utf-8",
          { ...PAGE_HEADERS, ...headers },
        );
      }
      problem(res, err.status, err.code, err.message, { ...headers, ...(err.retryAfter ? { "retry-after": String(err.retryAfter) } : {}) });
    }
  }

  function thanks(req: IncomingMessage, number: number) {
    const l = lang(req);
    const t = words(l);
    return page(l, t("formThanks"), `<h1>${esc(t("formThanks"))}</h1><p>${esc(t("formThanksText", { number: number || "" }))}</p>`);
  }

  async function publicMessage(req: IncomingMessage, res: ServerResponse, number: string) {
    try {
      const source = keyed(req);
      if (!source) throw new HdError(401, "invalid-token", "Send the source's key: Authorization: Bearer <key>.");
      const t = hd.intakeMessage(source.id, num(number), await readJson(req, 1024 * 1024));
      json(res, 201, { ticket: { number: t.number, reference: `#${t.number}`, status: t.status } });
    } catch (err) {
      if (!(err instanceof HdError)) throw err;
      if (!req.complete) req.resume();
      problem(res, err.status, err.code, err.message);
    }
  }

  // ------------------------------------------------------------------ satisfaction: /r/<token>

  async function satisfaction(req: IncomingMessage, res: ServerResponse, token: string, url: URL) {
    const l = lang(req);
    const t = words(l);
    const ticket = hd.ticketByToken(token);
    const asked = ticket?.csat_asked_at ? Date.parse(ticket.csat_asked_at) : null;
    if (!ticket || asked === null || hd.now() - asked > 30 * 86_400_000) {
      if (!req.complete) req.resume();
      return send(res, 404, page(l, t("pageGone"), `<h1>${esc(t("pageGone"))}</h1><p>${esc(t("pageGoneText"))}</p>`), "text/html; charset=utf-8", PAGE_HEADERS);
    }
    const until = new Date(asked + 30 * 86_400_000).toLocaleDateString(l, { dateStyle: "long" });
    if (req.method === "POST") {
      const form = new URLSearchParams(await readBody(req, 16 * 1024));
      const score = Number(form.get("score"));
      try {
        hd.rate(token, score, (form.get("comment") ?? "").trim() || null);
      } catch (err) {
        if (!(err instanceof HdError)) throw err;
      }
      if (Number.isInteger(score) && score >= 1 && score <= 5) {
        return send(
          res,
          200,
          page(l, t("pageThanks"), `<h1>${esc(t("pageThanks"))}</h1><p class="muted">${esc(t("pageChange", { date: until }))}</p>`),
          "text/html; charset=utf-8",
          PAGE_HEADERS,
        );
      }
    }
    // The links in the email open this page with the answer chosen; it is kept only when it is sent, so mail scanners
    // that open every link change nothing.
    const chosen = Number(url.searchParams.get("score")) || ticket.csat_score || 0;
    const scores = [5, 4, 3, 2, 1] as const;
    const body = `<h1>${esc(t("pageTitle"))}</h1>
<p class="muted">${esc(t("pageLead", { number: ticket.number, subject: ticket.subject }))}</p>
<form method="post" action="/r/${esc(token)}">
<fieldset><legend>${esc(t("pageScore"))}</legend>
${scores.map((s) => `<label class="score"><input type="radio" name="score" value="${s}" required${s === chosen ? " checked" : ""}> ${s} ${esc(t(`score${s}` as WordKey))}</label>`).join("\n")}
</fieldset>
<label for="comment">${esc(t("pageComment"))}</label>
<textarea id="comment" name="comment" maxlength="5000">${esc(ticket.csat_comment ?? "")}</textarea>
<button type="submit">${esc(t("pageSend"))}</button>
</form>`;
    send(res, 200, page(l, t("pageTitle"), body), "text/html; charset=utf-8", PAGE_HEADERS);
  }

  function authorize(req: IncomingMessage, access: Access): Actor {
    if (access === "none") return { id: "anonymous", name: "Anonymous" };
    if (tokenMatches(req.headers.authorization, adminToken)) return { id: "admin-token", name: "Admin token" };
    const p = auth.authorize(req, access);
    return p.kind === "session" ? { id: p.user.id, name: p.user.name } : { id: `token:${p.tokenId}`, name: p.name };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<string> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/healthz") return (json(res, 200, { status: "ok" }), "/healthz");

    if (path === "/readyz") {
      try {
        db.prepare("SELECT 1").get();
        if (!hd.config()) throw new Error("no settings");
        json(res, 200, { status: "ready" });
      } catch {
        json(res, 503, { status: "not ready" });
      }
      return "/readyz";
    }

    if (path === "/api/v1/public/tickets") {
      if (req.method === "POST") return (await publicTicket(req, res), path);
      if (req.method === "OPTIONS") {
        res
          .writeHead(204, {
            ...cors(req),
            "access-control-allow-methods": "POST",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "600",
          })
          .end();
        return path;
      }
    }
    const pm = /^\/api\/v1\/public\/tickets\/([^/]+)\/messages$/.exec(path);
    if (pm && req.method === "POST") return (await publicMessage(req, res, decodeURIComponent(pm[1]!)), "/api/v1/public/tickets/:number/messages");

    const r = /^\/r\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (r && (req.method === "GET" || req.method === "POST")) return (await satisfaction(req, res, r[1]!, url), "/r/:token");

    if (path === "/metrics") {
      // Not even the web UI's fallback answers here when metrics have their own port.
      if (serveMetrics) send(res, 200, metricsText(hd, version), "text/plain; version=0.0.4");
      else problem(res, 404, "not-found");
      return "/metrics";
    }

    if (path === "/api/openapi.json" && spec) return (send(res, 200, spec), "/api/openapi.json");

    if (docsDir && (path === "/api/docs" || path.startsWith("/api/docs/"))) {
      if (path === "/api/docs") {
        res.writeHead(301, { ...SECURITY_HEADERS, location: "/api/docs/" }).end();
        return "/api/docs";
      }
      const relative = path.slice("/api/docs/".length) || "index.html";
      if (!(await serveFile(res, docsDir, relative))) problem(res, 404, "not-found");
      return "/api/docs";
    }

    if (await auth.handle(req, res)) return auth.routeName(req) ?? "/api/v1/auth/*";

    for (const rt of compiled) {
      const m = path.match(rt.re);
      if (!m || rt.method !== req.method) continue;
      try {
        const who = authorize(req, rt.auth);
        const params = m.slice(1).map(decodeURIComponent);
        const result = await rt.handle({ req, res, url, params, who, body: () => readJson(req, rt.limit ?? 1024 * 1024) });
        if (!res.headersSent && result !== undefined) json(res, 200, result);
      } catch (err) {
        if (err instanceof AuthError) {
          sendProblem(res, err);
          if (!req.complete) req.resume();
          return rt.path;
        }
        if (!(err instanceof HdError)) throw err;
        problem(res, err.status, err.code, err.message, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
        // Unread request bodies would otherwise hold the connection.
        if (!req.complete) req.resume();
      }
      return rt.path;
    }

    if (path.startsWith("/api/")) return (problem(res, 404, "not-found"), "/api/*");

    if (webDir && (req.method === "GET" || req.method === "HEAD")) {
      // Unknown paths fall back to the single-page app.
      if (!(await serveFile(res, webDir, path === "/" ? "index.html" : path))) send(res, 200, await readFile(join(webDir, "index.html")), TYPES[".html"]);
      return "/web";
    }

    problem(res, 404, "not-found");
    return "unmatched";
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = performance.now();
    let routeName = "error";
    try {
      routeName = await route(req, res);
    } catch (err) {
      log("error", "request failed", { error: String(err), path: req.url });
      if (!res.headersSent) problem(res, 500, "internal-error");
    }
    countRequest(req.method ?? "GET", routeName, res.statusCode);
    // Satisfaction links carry their secret in the path; it is not written to the log.
    if (!["/healthz", "/metrics", "/r/:token"].includes(routeName)) {
      log("info", "request", { method: req.method, path: (req.url ?? "/").split("?")[0], status: res.statusCode, ms: Math.round(performance.now() - started) });
    }
  };
}
