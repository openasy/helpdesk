# helpdesk

[![CI](https://github.com/openasy/helpdesk/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/helpdesk/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Helpdesk product: emails to the support addresses, forms and chats become
tickets in queues, with owners, priorities and SLAs, replies from the support address, internal notes and saved
answers. Beside each ticket are the customer and their deals from CRM, and articles from Knowledge Base. After a
ticket is solved, the customer is asked how it went.

```
support@ (IMAP) ──┐
Forms, Live Chat ─┼─▶ routing rules (helpdesk.yaml) ─▶ queue + SLA ─▶ agents reply from support@ (SMTP)
a site's form ────┘                                                    └─▶ the customer's answer threads back
```

## Routing

A new ticket goes to the first queue, in the file's order, whose rule matches. A rule holds when every condition in
it holds, and a condition with a list holds when any value does; `match` can also be a list of rules.

| Condition | Matches |
| --- | --- |
| `address` | The support address the email was sent to |
| `channel` | `email`, `form` or `chat` |
| `source`, `form` | The source from the file, and the form id Forms sends |
| `subject_has` | Words or phrases at the start of a word, ignoring case and accents: `fatura` finds `Faturalar` |
| `from_domain` | The sender's domain or its subdomains |
| `plan` | The customer's plan from CRM, matched by email |

A queue with no `match` takes every ticket; when no queue matches, the last one does. Each ticket's thread says which
rule put it where (`Routed to Billing by the rule plan business`).

## SLA clocks

Each queue may set a target for the **first reply** and for the **solution**, and `sla_by_plan` overrides them for a
plan from CRM. Both clocks count **working time**: only inside the queue's `hours` (such as `weekdays 09:00-18:00`, in
its time zone, never on `support.holidays`), so a ticket opened on Friday at 17:30 with a one-hour target is due
Monday at 09:30. A day in a target is one working day: with 09:00 to 18:00, `1d` is nine working hours.

- Both clocks start when the ticket opens.
- They **pause while the ticket waits on the customer** (after a reply, or when an agent sets it) and run again when the
  customer answers.
- The first-reply clock stops at the first reply from the support address (or an agent's line in a chat). Internal
  notes stop nothing.
- The solution clock stops when the ticket is solved, and runs on from where it was if the customer reopens it.
- A clock that passes its target is **missed** and stays missed, even after a reply.
- Moving a ticket to another queue starts that queue's targets for the clocks that are neither met nor missed.

Reports count met and missed clocks, and the medians of first reply and solution in working time.

## Email

Each support address is read over **IMAP** and answered over **SMTP**, on any mail server. Addresses on
[OpenAsy Mail](https://github.com/openasy/mail) work the same way: Mail runs on Stalwart, which speaks both.
Each round connects, reads the mail since the last UID it read (unread mail of the last 14 days the first time),
marks it read and logs out. An email is read once: its Message-ID is kept.

**Threading.** A reply carries a Message-ID of ours (`<hd.1001.…@example.com>`), `In-Reply-To` the customer's last
email and `References` to the thread, so mail apps thread it, and the answer is matched by those headers. For apps
that drop them, `mail.reply_token` also puts the ticket in the subject (`[#1001]`, the default), in the reply address
(`support+1001-<tag>@`, signed so it cannot be guessed; your server must deliver `+` addresses), or both. A number in a
subject threads only email from someone already in the ticket. A reply more than `support.reopen_within` after a
ticket was solved opens a new ticket that follows the old one.

**Loops and automatic mail open no ticket:**

- `Auto-Submitted` other than `no`, `X-Autoreply`, `Precedence: bulk/junk/list`, `List-Id`, Exchange rule headers, and
  subjects such as `Automatic reply:` or `Abwesenheitsnotiz:`. An out-of-office to a reply is noted on its ticket.
- Bounces (delivery reports, mailer daemons): the reply they return is marked not delivered on its ticket.
- Mail from a support address, or carrying Helpdesk's own `X-OpenAsy-Helpdesk` header.
- More than `support.max_new_per_hour` new tickets from one sender, or 30 emails to one ticket, in an hour.

What Helpdesk sends on its own (the acknowledgement, the satisfaction question) carries `Auto-Submitted` and
`X-Auto-Response-Suppress`, and the acknowledgement goes at most once an hour to one address. Ignored emails are listed
under Integrations with the reason. A reply the mail server does not take waits in the outbox and is tried again
after 1, 5 and 15 minutes, 1 and 3 hours, then marked failed on its ticket.

**HTML** in emails is sanitized with [sanitize-html](https://github.com/apostrophecms/sanitize-html) before it is
stored: only text formatting stays; scripts, styles, style attributes, forms, frames and event handlers are removed,
links go to http(s) and mailto only, and remote images are dropped (they tell the sender an email was opened). Inline
`cid:` images point at their stored attachment. Agents see the new part of a reply by default and can open the whole
email. Attachments are downloaded in a sandbox; only PNG, JPEG, GIF and WebP are shown inline.

## Forms and Live Chat: the public ticket API

```
POST /api/v1/public/tickets
Authorization: Bearer <the key sources.<id>.key names>        (servers: Forms, Live Chat)
Origin: <one of sources.<id>.origins>                          (browsers, no key)

{ "source": "forms", "email": "gizem@example.com", "name": "Gizem Avcı", "subject": "Invoices fail",
  "message": "…", "form": "billing", "fields": { "Invoice no": "A-1002" }, "language": "tr",
  "external_id": "form-123" }

201 { "ticket": { "number": 1001, "reference": "#1001", "status": "open" }, "created": true }
```

- With a key, `source` may be left out; the key says which source it is. A key is the only way to send agents' chat
  lines.
- `external_id`: the same id from the same source answers 200 with the ticket it opened before, so a retry opens one
  ticket.
- Chats send `transcript: [{ from: customer|agent, name, at, text }]` instead of, or with, `message`. `email` is
  optional for chats; without it, the ticket cannot be answered by email. When an agent already answered in the chat,
  the first-reply clock is met.
- More of a chat goes to `POST /api/v1/public/tickets/<number>/messages` with the same key:
  `{ "from": "customer", "text": "…" }`. A customer's line opens a waiting ticket again.
- Browsers: pages on the source's `origins` may post with no key (CORS), up to 10 a minute from one address. Plain
  HTML forms post `application/x-www-form-urlencoded` (other answers as `fields[<name>]`) and get a thank-you page, or
  a 303 to `redirect` on one of the origins with `?ticket=<number>`. A filled hidden `website` field is dropped as a bot.

The [OpenAPI description](./openapi.json) is the full contract.

## CRM: the customer beside each ticket

CRM is matched by the customer's **email address only**: no names, domains or guesses. With `crm.url` in the file,
Helpdesk asks:

```
GET <crm.url>/api/v1/lookup?email=gizem@avci.example
Authorization: Bearer <the key crm.token names>

200 { "contact": { "id": "c-1", "name": "Gizem Avcı", "email": "gizem@avci.example", "title": "Finance lead",
                   "company": { "name": "Avcı Lojistik", "users": 48 },
                   "plan": { "id": "business", "name": "Business", "renews": "2026-12-31" },
                   "owner": { "name": "Hakan Yıldız", "email": null }, "url": "https://crm.example.com/contacts/c-1" },
      "deals": [ { "id": "d-1", "name": "Renewal", "amount": 300000, "currency": "TRY", "stage": "Proposal",
                   "status": "open", "url": null } ] }
404 when no contact has exactly that address
```

Only fields of the right type are kept, and an answer for another address is ignored. The plan's `id` is what routing
rules (`plan`) and `sla_by_plan` match. Answers are kept five minutes. A CRM that does not answer within three seconds
leaves the ticket routed without the plan, and the thread says so. Without `crm` in the file, nothing from CRM is
shown. In the code, CRM is behind the `CustomerDirectory` interface (`server/links.ts`); the schema is `CrmLookup` in
`openapi.json`.

## Knowledge Base

With `knowledge_base.url`, the ticket page asks Knowledge Base's `GET /api/v1/suggest?place=helpdesk-agent` for up to
three articles about the ticket's subject, shown beside the reply box; an agent can put an article's link in the
reply. Without it, nothing is shown.

## Satisfaction

`satisfaction.ask_after_solved` (default `1h`, `off` to never ask) after a ticket is solved, the customer gets one email
with five answers. Each links to `/r/<token>?score=N`, a page with that answer chosen; the answer is kept only when the
page is sent, so mail scanners that open every link change nothing. The answer and an optional comment can be changed
for 30 days. The page and the email are in English, German or Turkish (`support.language`; the page follows the
browser).

## The settings file

`/config/helpdesk.yaml` (`HELPDESK_CONFIG`), as in [config/helpdesk.yaml](./config/helpdesk.yaml). No screen and no API
route changes it. It is read at start and within a minute of a change, and applied whole or not at all: a file with a
mistake leaves the last good version in place, and the log and the Settings page say which field to fix. Secrets are
never in it; it names the environment variables that hold them. Without a file, Helpdesk starts with one queue and no
addresses.

| Field | Default | |
| --- | --- | --- |
| `support.name`, `support.language` | `Support`, `en` | The name replies go out with; the language of Helpdesk's own emails |
| `support.time_zone`, `support.holidays` | `UTC` | For the queues' hours; days no clock runs |
| `support.reopen_within` | `7d` | A reply after this opens a new ticket |
| `support.acknowledge` | `false` | Tell new customers their request is in |
| `support.max_new_per_hour` | `10` | New tickets one sender may open in an hour |
| `mail.imap`, `mail.smtp` | | `{ host, port, tls }`; `tls: false` is STARTTLS, which is then required |
| `mail.user`, `mail.password` | the address, `HELPDESK_MAIL_PASSWORD` | The login, and the variable with the password |
| `mail.check_every`, `mail.reply_token` | `1m`, `subject` | |
| `addresses` | | Addresses, or `{ address, name, user, password, folder, imap, smtp }` |
| `queues.<id>` | `general` | `{ name, match, hours, time_zone, sla, sla_by_plan, priority }` |
| `satisfaction.ask_after_solved` | `1h` | |
| `answers` | | Saved answers: `{ id, title, text, queues }`, with `{first_name}`, `{name}`, `{number}`, `{agent}`, `{queue}` |
| `sources.<id>` | | `{ name, channel, key, origins, address }` |
| `crm` | | `{ url, token }` |
| `knowledge_base` | | `{ url, language }` |

## Run

```bash
openssl rand -hex 32 > openasy-kek
$EDITOR config/helpdesk.yaml
docker compose up -d
docker compose logs helpdesk | grep 'no owner yet'
```

Open the link from the log once to create the owner account; there is no default password (ADR 0013).

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HELPDESK_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy; satisfaction links use it |
| `HELPDESK_CONFIG` | `/config/helpdesk.yaml` | The settings file |
| the variables the file names | | Mail passwords, sources' keys, the CRM token |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `HELPDESK_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key |
| `HELPDESK_DB` | `/data/helpdesk.db` | SQLite file (WAL), on the `/data` volume: tickets, threads and attachments |
| `HELPDESK_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `HELPDESK_HEADLESS` | `false` | `true` serves no team UI; the API stays |
| `HELPDESK_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in for the team, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Metrics
include tickets by status, SLAs missed now, mail read and sent by result, the outbox and addresses that cannot be read.
Satisfaction links are not written to the request log.

## Roles

Viewers see tickets and reports; editors answer, add notes, assign and move tickets; admins also read mail on demand and
manage members and API tokens (ADR 0003). The public ticket API takes a source's key or an allowed origin, and the
satisfaction page its link.

## Develop

```bash
npm install
npm test        # settings, working hours, SLA clocks, routing, threading, loops and bounces, sanitizing, forms and chats,
                # mail through imapflow and nodemailer to in-process servers, and every API response against openapi.json
npm run e2e     # the mail path against a real Stalwart in Docker
npm run dev     # the UI, with the API on :8080
```

The team UI follows the Helpdesk screens in the [ui](https://github.com/openasy/ui) Storybook. Its read-only Settings
page is rebuilt here from published components (`web/src/FileSettings.tsx`) until the shared page is in a published
`@openasy/ui`.

## Licence

AGPL-3.0 (ADR 0008).
