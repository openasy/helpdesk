import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createAuth, oidcFromEnv, readSecretsKey } from "@openasy/auth";
import { createApp, createMetricsHandler } from "./app.ts";
import { parseConfig, watchConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { createHelpdesk } from "./helpdesk.ts";
import { log } from "./log.ts";
import { imapReader, smtpSender } from "./mailer.ts";
import { parseProducts } from "./products.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const port = Number(process.env.PORT ?? 8080);
const dbPath = process.env.HELPDESK_DB ?? "/data/helpdesk.db";
const configPath = process.env.HELPDESK_CONFIG?.trim() || "/config/helpdesk.yaml";
const webDir = new URL("../dist/web", import.meta.url).pathname;
const docsDir = new URL("../dist/docs", import.meta.url).pathname;
const openapi = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8")) as Record<string, unknown>;
const headless = process.env.HELPDESK_HEADLESS === "true";
// Set it to keep /metrics off the port that is published or behind an ingress (ADR 0026).
const metricsPort = process.env.HELPDESK_METRICS_PORT ? Number(process.env.HELPDESK_METRICS_PORT) : undefined;

const db = openDb(dbPath);
// The address people open Helpdesk at, behind the TLS proxy (ADR 0026). Cookies, passkeys, OIDC redirects and the
// satisfaction links in emails use it.
const publicUrl = (process.env.HELPDESK_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
const secretsKeyFile = process.env.HELPDESK_SECRETS_KEY_FILE ?? "/run/secrets/openasy-kek";
const auth = createAuth({
  db,
  product: "helpdesk",
  productName: "OpenAsy Helpdesk",
  origin: publicUrl,
  // Locally the same product is often opened as 127.0.0.1 too.
  trustedOrigins: publicUrl.startsWith("http://localhost:") ? [publicUrl.replace("localhost", "127.0.0.1")] : [],
  passwords: process.env.HELPDESK_PASSWORD_SIGN_IN !== "false",
  oidc: oidcFromEnv(process.env),
  secretsKey: readSecretsKey(secretsKeyFile),
  // Audit log (ADR 0013): every sign-in, failure and change to members and tokens.
  onEvent: (event) => log(event.type === "sign-in-failed" ? "warn" : "info", "auth", { event }),
});
let file: ReturnType<typeof watchConfig> | undefined;
const sender = smtpSender();
const hd = createHelpdesk(db, { publicUrl, sender, reader: imapReader(), fileState: () => file?.state ?? null, log });
// The settings come from the file and only from it; a file with a mistake keeps the last good one in place.
file = watchConfig(configPath, (config, text) => hd.setConfig(config, text), {
  onChange: (state) =>
    state.error
      ? log("warn", "settings file not applied: the last good version stays until it is fixed", { file: state.path, error: state.error })
      : log("info", "settings file applied", { file: state.path, warnings: state.warnings }),
});
// Without a file, Helpdesk starts with one queue and no addresses, so a first look needs nothing written.
if (!hd.config()) {
  hd.setConfig(parseConfig(""), "");
  log("warn", "no settings file applied: using the defaults until it can be read", { file: configPath });
}
const products = parseProducts(process.env.OPENASY_PRODUCTS);
if (products.invalid.length) log("warn", "OPENASY_PRODUCTS: left out entries that are not id=https://address", { entries: products.invalid });
const server = createServer(
  createApp({
    db,
    hd,
    version,
    publicUrl,
    auth,
    webDir: !headless && existsSync(webDir) ? webDir : undefined,
    docsDir: existsSync(docsDir) ? docsDir : undefined,
    openapi,
    serveMetrics: metricsPort === undefined,
    products: products.products,
  }),
);
const metricsServer = metricsPort !== undefined ? createServer(createMetricsHandler(hd, version)) : undefined;
metricsServer?.listen(metricsPort, () => log("info", "metrics on their own port", { port: metricsPort }));

server.listen(port, () => log("info", "helpdesk started", { version, port, db: dbPath, config: configPath, headless }));
if (!publicUrl.startsWith("https://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(publicUrl)) {
  log(
    "warn",
    "HELPDESK_PUBLIC_URL is not https: browsers will not keep secure cookies or allow passkeys, and satisfaction links go out unencrypted. Put it behind TLS (ADR 0026)",
    {
      url: publicUrl,
    },
  );
}
if (auth.secretsInClear)
  log("warn", "no secrets key: TOTP secrets are stored unencrypted. Mount a 32-byte key (openssl rand -hex 32)", { file: secretsKeyFile });
const setup = auth.setupLink();
// No default password (ADR 0013): the first person to open this link becomes the owner.
if (setup) log("info", "no owner yet: open this link once to create the owner account", { url: setup });

const background = (name: string, work: () => Promise<void>) => () =>
  void work().catch((err: unknown) => log("error", `${name} failed`, { error: String(err) }));
hd.purge();
const timers: NodeJS.Timeout[] = [
  setInterval(() => auth.purge(), 5 * 60_000),
  setInterval(() => hd.purge(), 3_600_000),
  // Each address is read when its turn comes (mail.check_every); the outbox, satisfaction and closing every 15 seconds.
  setInterval(
    background("reading mail", () => hd.checkMail()),
    10_000,
  ),
  setInterval(
    background("sending mail", () => hd.tick()),
    15_000,
  ),
];
background("reading mail", () => hd.checkMail())();

function shutdown(signal: string) {
  log("info", "shutting down", { signal });
  for (const t of timers) clearInterval(t);
  file?.stop();
  sender.close();
  metricsServer?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
