// A small IMAP server for tests: one account, one INBOX, and the commands imapflow sends to log in, open the folder,
// search, fetch and mark mail read (RFC 3501). It speaks plain TCP; the reader is told so with allowPlain.
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

interface Stored {
  uid: number;
  raw: Buffer;
  seen: boolean;
  date: Date;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Splits an IMAP command's arguments: atoms, "quoted strings", (lists) and literals already read in. */
function tokens(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") {
      i++;
      continue;
    }
    if (s[i] === '"') {
      let j = i + 1;
      let v = "";
      while (j < s.length && s[j] !== '"') {
        if (s[j] === "\\") j++;
        v += s[j];
        j++;
      }
      out.push(v);
      i = j + 1;
    } else if (s[i] === "(") {
      let depth = 0;
      let j = i;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        if (s[j] === ")" && --depth === 0) break;
      }
      out.push(s.slice(i, j + 1));
      i = j + 1;
    } else {
      let j = i;
      while (j < s.length && s[j] !== " ") j++;
      out.push(s.slice(i, j));
      i = j;
    }
  }
  return out;
}

function inSet(set: string, n: number, max: number): boolean {
  return set.split(",").some((part) => {
    const [a, b] = part.split(":").map((x) => (x === "*" ? max : Number(x)));
    if (b === undefined) return n === a;
    return n >= Math.min(a!, b) && n <= Math.max(a!, b);
  });
}

export async function startImap(account: { user: string; pass: string }) {
  const mail: Stored[] = [];
  let uidNext = 1;
  const commands: string[] = [];
  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const write = (s: string | Buffer) => socket.write(s);
    write("* OK [CAPABILITY IMAP4rev1 UIDPLUS] test server ready\r\n");
    let buffer = Buffer.alloc(0);
    let pending = "";
    let need = 0;
    let authed = false;

    const handle = (line: string) => {
      const [tag, ...rest] = tokens(line);
      let cmd = (rest.shift() ?? "").toUpperCase();
      let uid = false;
      if (cmd === "UID") {
        uid = true;
        cmd = (rest.shift() ?? "").toUpperCase();
      }
      commands.push(`${uid ? "UID " : ""}${cmd}`);
      const ok = (text = "done") => write(`${tag} OK ${text}\r\n`);
      const max = uid ? (mail.at(-1)?.uid ?? 0) : mail.length;
      const pick = (set: string) => mail.map((m, i) => ({ m, seq: i + 1 })).filter(({ m, seq }) => inSet(set, uid ? m.uid : seq, max));
      switch (cmd) {
        case "CAPABILITY":
          write("* CAPABILITY IMAP4rev1 UIDPLUS\r\n");
          return ok();
        case "LOGIN":
          if (rest[0] === account.user && rest[1] === account.pass) {
            authed = true;
            return ok("[CAPABILITY IMAP4rev1 UIDPLUS] logged in");
          }
          return write(`${tag} NO [AUTHENTICATIONFAILED] wrong user or password\r\n`);
        case "SELECT":
        case "EXAMINE":
          if (!authed) return write(`${tag} NO log in first\r\n`);
          write("* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n");
          write("* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] flags\r\n");
          write(`* ${mail.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 7] uids\r\n* OK [UIDNEXT ${uidNext}] next\r\n`);
          return ok(`[READ-${cmd === "SELECT" ? "WRITE" : "ONLY"}] selected`);
        case "SEARCH": {
          let found = mail.map((m, i) => ({ m, seq: i + 1 }));
          for (let i = 0; i < rest.length; i++) {
            const k = rest[i]!.toUpperCase();
            if (k === "UNSEEN") found = found.filter((x) => !x.m.seen);
            else if (k === "SEEN") found = found.filter((x) => x.m.seen);
            else if (k === "SINCE") {
              const [d, mo, y] = rest[++i]!.split("-");
              const since = Date.UTC(Number(y), MONTHS.indexOf(mo!.toLowerCase()), Number(d));
              found = found.filter((x) => x.m.date.getTime() >= since);
            } else if (k === "UID") {
              const set = rest[++i]!;
              found = found.filter((x) => inSet(set, x.m.uid, mail.at(-1)?.uid ?? 0));
            }
          }
          write(`* SEARCH${found.map((x) => ` ${uid ? x.m.uid : x.seq}`).join("")}\r\n`);
          return ok();
        }
        case "FETCH": {
          const items = (rest.slice(1).join(" ") ?? "").toUpperCase();
          for (const { m, seq } of pick(rest[0]!)) {
            const parts = [`UID ${m.uid}`];
            if (items.includes("FLAGS")) parts.push(`FLAGS (${m.seen ? "\\Seen" : ""})`);
            if (items.includes("BODY[]") || items.includes("BODY.PEEK[]") || items.includes("RFC822")) {
              write(`* ${seq} FETCH (${parts.join(" ")} BODY[] {${m.raw.length}}\r\n`);
              write(m.raw);
              write(")\r\n");
            } else write(`* ${seq} FETCH (${parts.join(" ")})\r\n`);
            if (!items.includes("PEEK") && items.includes("BODY[]")) m.seen = true;
          }
          return ok();
        }
        case "STORE": {
          const what = rest[1]!.toUpperCase();
          for (const { m, seq } of pick(rest[0]!)) {
            if (rest.slice(2).join(" ").includes("\\Seen")) m.seen = !what.startsWith("-");
            if (!what.includes("SILENT")) write(`* ${seq} FETCH (UID ${m.uid} FLAGS (${m.seen ? "\\Seen" : ""}))\r\n`);
          }
          return ok();
        }
        case "LOGOUT":
          write("* BYE logging out\r\n");
          ok();
          return void socket.end();
        default:
          return ok();
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (need > 0) {
          if (buffer.length < need) return;
          // A literal's text goes in as a quoted string, so the command is one line to read.
          pending += `"${buffer
            .subarray(0, need)
            .toString("utf8")
            .replace(/["\\]/g, (c) => `\\${c}`)}"`;
          buffer = buffer.subarray(need);
          need = 0;
          continue;
        }
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 2);
        const literal = /\{(\d+)(\+?)\}$/.exec(line);
        if (literal) {
          pending += line.slice(0, literal.index);
          need = Number(literal[1]);
          if (!literal[2]) write("+ go ahead\r\n");
          continue;
        }
        const full = pending + line;
        pending = "";
        handle(full);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    commands,
    mail,
    /** Delivers an email to the INBOX. */
    deliver(raw: string | Buffer, date = new Date()) {
      mail.push({ uid: uidNext++, raw: Buffer.isBuffer(raw) ? raw : Buffer.from(raw.replace(/\r?\n/g, "\r\n")), seen: false, date });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
