// Queues: open tickets with their SLAs. Ticket: one ticket with its thread, the customer from CRM, the SLA clocks and
// the reply box, with saved answers and articles from Knowledge Base beside it.
import { useAuth } from "@openasy/auth/react";
import {
  Avatar,
  Badge,
  Button,
  Callout,
  DataTable,
  EmptyState,
  IconButton,
  navigate,
  PageHeader,
  Panel,
  SearchInput,
  SelectField,
  StatusBadge,
  Tabs,
  type Column,
} from "@openasy/ui";
import { ArrowLeft, ExternalLink, FileSearch, Lock, Paperclip, RotateCcw, SendHorizontal, UserCheck, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { Articles, Customer, Member, Message, Priority, Settings, Ticket, TicketDetail } from "./api.ts";
import {
  CHANNEL_ICON,
  date,
  duration,
  money,
  Notice,
  PRIORITIES,
  PRIORITY_TONE,
  ref,
  slaText,
  statusTone,
  time,
  useLoad,
  useNow,
  when,
  type Call,
} from "./common.tsx";
import { useT, type T } from "./i18n.ts";

type Tab = "open" | "waiting" | "solved";
const inTab = (t: Ticket, tab: Tab) => (tab === "solved" ? t.status === "solved" || t.status === "closed" : t.status === tab);

// ---------------------------------------------------------------- Queues

export function QueuePage({ call, settings, onChanged }: { call: Call; settings: Settings; onChanged: () => void }) {
  const t = useT();
  const now = useNow();
  const { me, can } = useAuth();
  const [data, reload] = useLoad<{ tickets: Ticket[] }>(call, "/api/v1/tickets?limit=1000", 30_000);
  const [queue, setQueue] = useState<string>("all");
  const [tab, setTab] = useState<Tab>("open");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = data?.tickets ?? [];
  const queues = settings.config!.queues;
  const inQueue = rows.filter((x) => queue === "all" || x.queue.id === queue);
  const words = query.trim().toLocaleLowerCase();
  const shown = inQueue.filter(
    (x) => inTab(x, tab) && (!words || `#${x.number} ${x.subject} ${x.customer.name ?? ""} ${x.customer.email ?? ""}`.toLocaleLowerCase().includes(words)),
  );

  async function assignToMe() {
    setError(null);
    try {
      await call<{ assigned: number }>("/api/v1/tickets/assign", { method: "POST", body: JSON.stringify({ tickets: selected.map(Number), owner: "me" }) });
      setNotice(t("queue.assigned", { count: selected.length, name: me.user.name }));
      setSelected([]);
      reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const cols: Column<Ticket>[] = [
    { id: "number", header: "#", mono: true, width: "64px", sortValue: (x) => x.number, cell: (x) => <span className="text-xs">{x.number}</span> },
    {
      id: "subject",
      header: t("queue.subject"),
      width: "34%",
      sortValue: (x) => x.subject,
      cell: (x) => {
        const Icon = CHANNEL_ICON[x.channel];
        return (
          <span className="flex min-w-0 items-center gap-2">
            <Icon aria-label={t(`channel.${x.channel}`)} className="size-3.5 shrink-0 text-fg-muted" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{x.subject}</span>
              <span className="truncate text-2xs text-fg-muted">{x.customer.name ?? x.customer.email ?? t("ticket.visitor")}</span>
            </span>
          </span>
        );
      },
    },
    { id: "queue", header: t("queue.queue"), sortValue: (x) => x.queue.name, cell: (x) => <span className="text-xs">{x.queue.name}</span> },
    {
      id: "priority",
      header: t("queue.priority"),
      sortValue: (x) => PRIORITIES.indexOf(x.priority),
      cell: (x) => <Badge tone={PRIORITY_TONE[x.priority]}>{t(`priority.${x.priority}`)}</Badge>,
    },
    {
      id: "sla",
      header: "SLA",
      sortValue: (x) => slaText(x, t, now).sort,
      cell: (x) => {
        const d = slaText(x, t, now);
        return <StatusBadge tone={d.tone}>{d.text}</StatusBadge>;
      },
    },
    {
      id: "owner",
      header: t("queue.owner"),
      sortValue: (x) => x.owner?.name ?? "",
      cell: (x) =>
        x.owner ? (
          <span className="flex items-center gap-1.5">
            <Avatar name={x.owner.name} size="sm" className="size-5" />
            <span className="truncate text-xs">{x.owner.name}</span>
          </span>
        ) : (
          <span className="text-xs text-fg-muted">{t("ticket.notAssigned")}</span>
        ),
    },
    {
      id: "updated",
      header: t("queue.updated"),
      align: "right",
      sortValue: (x) => x.updatedAt,
      cell: (x) => <span className="text-xs text-fg-muted">{when(x.updatedAt, t, now)}</span>,
    },
  ];

  const list = [{ id: "all", name: t("queue.all") }, ...queues.map((q) => ({ id: q.id, name: q.name }))];
  return (
    <>
      <PageHeader title={t("queue.title")} description={t("queue.description")} />
      {notice && <Notice>{notice}</Notice>}
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5">
          {error}
        </Callout>
      )}
      <div className="hd-queues grid gap-2.5">
        <Panel flush aria-label={t("queue.queues")}>
          <ul className="hd-list flex flex-col py-1">
            {list.map((q) => {
              const n = rows.filter((x) => x.status === "open" && (q.id === "all" || x.queue.id === q.id)).length;
              return (
                <li key={q.id}>
                  <button
                    type="button"
                    onClick={() => (setQueue(q.id), setSelected([]))}
                    aria-current={q.id === queue ? "true" : undefined}
                    className={`hd-queue flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm ${q.id === queue ? "bg-accent-soft text-accent-text" : "text-fg"}`}
                  >
                    <span className="truncate">{q.name}</span>
                    <span className="text-2xs text-fg-muted tabular-nums">{n}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
        <Panel flush aria-label={t("queue.tickets")}>
          <div className="flex flex-wrap items-end justify-between gap-2 px-3 pt-2">
            <Tabs
              label={t("queue.status")}
              value={tab}
              onChange={(s) => (setTab(s), setSelected([]))}
              items={(["open", "waiting", "solved"] as const).map((s) => ({
                value: s,
                label: t(`status.${s}`),
                count: inQueue.filter((x) => inTab(x, s)).length,
              }))}
              className="border-b-0"
            />
            <span className="flex items-center gap-2 pb-1.5">
              {selected.length > 0 && can("editor") && (
                <Button size="sm" icon={<UserCheck />} onClick={() => void assignToMe()}>
                  {t("queue.assignToMe", { count: selected.length })}
                </Button>
              )}
              <SearchInput
                label={t("queue.search")}
                placeholder={t("queue.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-56"
              />
            </span>
          </div>
          <div className="border-t border-line">
            <DataTable
              label={t("queue.tickets")}
              columns={cols}
              rows={shown}
              getRowId={(x) => String(x.number)}
              selectable={can("editor")}
              selectedIds={selected}
              onSelectionChange={setSelected}
              onRowClick={(x) => navigate(`/tickets/${x.number}`)}
              defaultSort={{ id: "sla", direction: "asc" }}
              minWidth={860}
              loading={data === undefined}
              empty={data === null ? t("common.loadFailed") : t("queue.empty")}
            />
          </div>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Ticket

/** A system line in the thread, in the page's language from its event and values; the server's English otherwise. */
function systemText(m: Message, t: T): string {
  const d = (m.data ?? {}) as Record<string, string | number | null>;
  const s = (k: string) => String(d[k] ?? "");
  switch (m.event) {
    case "opened": {
      const from =
        d.channel === "email"
          ? t("event.fromEmail", { address: s("address") })
          : d.channel === "chat"
            ? t("event.fromChat", { source: s("source") })
            : t("event.fromForm", { source: s("source") });
      const sla = [
        d.firstReply ? t("event.slaFirst", { target: s("firstReply") }) : null,
        d.solution ? t("event.slaSolution", { target: s("solution") }) : null,
      ]
        .filter(Boolean)
        .join(", ");
      return t(sla ? "event.openedSla" : "event.opened", { from, queue: s("queue"), rule: s("rule"), sla });
    }
    case "follows":
      return t("event.follows", { number: s("ticket") });
    case "crm-unavailable":
      return t("event.crmUnavailable");
    case "reopened":
      return d.by ? t("event.reopenedBy", { name: s("by") }) : t("event.reopened");
    case "moved":
      return t("event.moved", { from: s("from"), to: s("to"), name: s("by") });
    case "assigned":
      return d.to ? t("event.assigned", { to: s("to"), name: s("by") }) : t("event.unassigned", { name: s("by") });
    case "priority":
      return t("event.priority", { from: t(`priority.${s("from") as Priority}`), to: t(`priority.${s("to") as Priority}`), name: s("by") });
    case "status":
      return d.to === "waiting" ? t("event.waiting", { name: s("by") }) : t("event.openAgain", { name: s("by") });
    case "solved":
      return t("event.solved", { name: s("by") });
    case "satisfaction-asked":
      return t("event.asked", { email: m.to[0] ?? "" });
    case "acknowledged":
      return t("event.acknowledged", { email: m.to[0] ?? "" });
    case "satisfaction":
      return d.comment ? t("event.ratedComment", { score: s("score"), comment: s("comment") }) : t("event.rated", { score: s("score") });
    case "auto-reply":
      return t("event.autoReply", { from: s("from"), subject: s("subject") });
    case "bounce":
      return t("event.bounce", { recipients: ((m.data?.recipients as string[] | undefined) ?? []).join(", ") || t("event.theCustomer") });
    case "delivery-failed":
      return t("event.deliveryFailed", { error: s("error") });
    default:
      return m.body;
  }
}

function MessageItem({ m, address }: { m: Message; address: string | null }) {
  const t = useT();
  const [full, setFull] = useState(false);
  if (m.kind === "system")
    return (
      <li className="text-center text-2xs text-fg-muted">
        {time(m.at)} · {systemText(m, t)}
        {m.delivery === "failed" && <span className="text-danger-text"> · {t("ticket.notDelivered")}</span>}
      </li>
    );
  const fields = (m.data?.fields as Record<string, string> | undefined) ?? null;
  const tone = m.kind === "note" ? "hd-note" : m.kind === "agent" ? "hd-agent" : "border-line bg-surface";
  const role =
    m.kind === "note"
      ? t("ticket.internalNote")
      : m.kind === "agent"
        ? m.via === "chat"
          ? t("ticket.inChat")
          : t("ticket.replyFrom", { address: m.author.email ?? address ?? "" })
        : m.via === "email"
          ? (m.author.email ?? t("ticket.customer"))
          : t("ticket.customerVia", { via: t(`channel.${m.via === "chat" ? "chat" : "form"}`) });
  return (
    <li className={`flex gap-2 rounded-md border p-2.5 ${tone}`}>
      <Avatar name={m.author.name} size="sm" />
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold text-fg">{m.author.name}</span>
          <span className="text-fg-muted">{role}</span>
          <span className="text-fg-muted">
            {date(m.at)} {time(m.at)}
          </span>
          {m.delivery === "queued" && <StatusBadge tone="warning">{m.deliveryError ? t("ticket.retrying") : t("ticket.sending")}</StatusBadge>}
          {m.delivery === "failed" && <StatusBadge tone="danger">{t("ticket.notDelivered")}</StatusBadge>}
        </span>
        {m.cc.length > 0 && m.kind !== "customer" && <span className="text-2xs text-fg-muted">{t("ticket.cc", { list: m.cc.join(", ") })}</span>}
        {full && m.html ? (
          <div className="hd-email text-sm text-fg" dangerouslySetInnerHTML={{ __html: m.html }} />
        ) : (
          <span className="whitespace-pre-wrap text-sm text-fg hd-wrap">{full && m.fullText ? m.fullText : m.body}</span>
        )}
        {fields && (
          <dl className="hd-facts mt-1 grid gap-x-2 gap-y-0.5 text-xs">
            {Object.entries(fields).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-fg-muted">{k}</dt>
                <dd className="m-0 text-fg">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        {m.attachments.length > 0 && (
          <ul aria-label={t("ticket.attachments")} className="hd-list mt-1 flex flex-wrap gap-2">
            {m.attachments.map((a) => (
              <li key={a.id}>
                <a href={`/api/v1/attachments/${a.id}`} className="flex items-center gap-1 text-xs text-accent-text" download={a.filename}>
                  <Paperclip aria-hidden className="size-3" />
                  {a.filename} <span className="text-fg-muted">({Math.max(1, Math.round(a.size / 1024))} KB)</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {(m.html || m.fullText) && (
          <button type="button" className="hd-link self-start text-2xs text-accent-text" onClick={() => setFull((x) => !x)} aria-expanded={full}>
            {full ? t("ticket.showLess") : m.html ? t("ticket.showEmail") : t("ticket.showQuoted")}
          </button>
        )}
      </span>
    </li>
  );
}

interface Upload {
  name: string;
  type: string;
  data: string;
  size: number;
}

function Composer({
  ticket,
  onSend,
  insert,
}: {
  ticket: TicketDetail;
  onSend: (text: string, note: boolean, attachments: Upload[], solve: boolean) => Promise<boolean>;
  insert: { text: string; n: number } | null;
}) {
  const t = useT();
  const id = useId();
  const file = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"reply" | "note">(ticket.canReply ? "reply" : "note");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (insert) setText((x) => (x ? `${x}\n${insert.text}` : insert.text));
  }, [insert]);
  const name = ticket.customer.name ?? ticket.customer.email ?? t("ticket.visitor");
  const send = async (solve: boolean) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onSend(text.trim(), mode === "note", mode === "note" ? [] : files, solve);
    setBusy(false);
    if (ok) (setText(""), setFiles([]));
  };
  const submit = (e: FormEvent) => (e.preventDefault(), void send(false));
  async function pick(list: FileList | null) {
    const read = await Promise.all(
      [...(list ?? [])].slice(0, 10).map(
        (f) =>
          new Promise<Upload>((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve({ name: f.name, type: f.type || "application/octet-stream", size: f.size, data: String(r.result).split(",")[1] ?? "" });
            r.onerror = () => reject(r.error);
            r.readAsDataURL(f);
          }),
      ),
    );
    setFiles((x) => [...x, ...read].slice(0, 10));
  }
  return (
    <form onSubmit={submit} aria-label={t("ticket.answer")} className="flex flex-col gap-1.5 border-t border-line p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          label={t("ticket.answerAs")}
          value={mode}
          onChange={setMode}
          items={[
            ...(ticket.canReply ? [{ value: "reply" as const, label: t("ticket.replyTo", { name }) }] : []),
            { value: "note" as const, label: t("ticket.internalNote") },
          ]}
          className="border-b-0"
        />
        {ticket.answers.length > 0 && (
          <SelectField
            aria-label={t("ticket.savedAnswers")}
            value=""
            onChange={(e) => {
              const a = ticket.answers.find((x) => x.id === e.target.value);
              if (a) setText(a.text);
            }}
            options={[{ value: "", label: t("ticket.savedAnswers") }, ...ticket.answers.map((a) => ({ value: a.id, label: a.title }))]}
            className="w-64"
          />
        )}
      </div>
      <div className={`hd-composer flex flex-col rounded-md border ${mode === "note" ? "border-warning bg-warning-soft" : "border-line bg-surface"}`}>
        <label htmlFor={id} className="sr-only">
          {mode === "note" ? t("ticket.note") : t("ticket.reply")}
        </label>
        <textarea
          id={id}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={mode === "note" ? t("ticket.notePlaceholder") : t("ticket.replyPlaceholder", { address: ticket.address ?? "" })}
          className="hd-textarea w-full bg-transparent px-2.5 pt-2 text-sm text-fg"
        />
        {files.length > 0 && mode === "reply" && (
          <ul aria-label={t("ticket.attachments")} className="hd-list flex flex-wrap gap-1.5 px-2.5 pt-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-md bg-subtle px-1.5 py-0.5 text-2xs">
                {f.name}
                <IconButton label={t("ticket.removeFile", { name: f.name })} size="xs" onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}>
                  <X className="size-3" />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <span className="flex items-center gap-1 px-1.5 pb-1.5">
          {mode === "reply" && (
            <>
              <IconButton label={t("ticket.attach")} size="xs" onClick={() => file.current?.click()}>
                <Paperclip className="size-3.5" />
              </IconButton>
              <input ref={file} type="file" multiple hidden onChange={(e) => void pick(e.target.files).then(() => (e.target.value = ""))} />
            </>
          )}
          <span className="grow" />
          {mode === "reply" && ticket.status !== "solved" && ticket.status !== "closed" && (
            <Button type="button" size="xs" disabled={busy} onClick={() => void send(true)}>
              {t("ticket.sendSolve")}
            </Button>
          )}
          <Button type="submit" size="xs" variant="primary" disabled={busy} icon={mode === "note" ? <Lock /> : <SendHorizontal />}>
            {mode === "note" ? t("ticket.addNote") : t("ticket.send")}
          </Button>
        </span>
      </div>
    </form>
  );
}

function ClockRow({ label, clock, t, now }: { label: string; clock: TicketDetail["clocks"]["firstReply"]; t: T; now: number }) {
  if (!clock) return null;
  let badge: { tone: "success" | "danger" | "neutral" | "warning"; text: string };
  if (clock.state === "met") badge = { tone: "success", text: t("sla.metAt", { at: `${date(clock.doneAt!)} ${time(clock.doneAt!)}` }) };
  else if (clock.state === "missed") badge = { tone: "danger", text: t("sla.missedAt", { at: `${date(clock.missedAt!)} ${time(clock.missedAt!)}` }) };
  else if (clock.state === "paused") badge = { tone: "neutral", text: t("sla.pausedLeft", { left: duration(clock.remaining, t) }) };
  else badge = { tone: clock.remaining < 3_600_000 ? "warning" : "neutral", text: t("sla.left", { left: duration(Date.parse(clock.dueAt!) - now, t) }) };
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="text-fg-muted">{label}</span>
      <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
    </li>
  );
}

function CustomerPanel({ call, number }: { call: Call; number: number }) {
  const t = useT();
  const [c] = useLoad<Customer>(call, `/api/v1/tickets/${number}/customer`);
  // CRM not linked: nothing at all is shown.
  if (!c || !c.linked) return null;
  const deal = c.deals.find((d) => d.status === "open");
  return (
    <Panel title={t("customer.title")} description={t("customer.description")} aria-label={t("customer.title")}>
      {c.error ? (
        <p className="text-xs text-fg-muted">{t("customer.unavailable")}</p>
      ) : !c.contact ? (
        <p className="text-xs text-fg-muted">{c.email ? t("customer.notFound", { email: c.email }) : t("customer.noEmail")}</p>
      ) : (
        <div className="flex flex-col gap-2 text-xs">
          <span className="flex items-center gap-2">
            <Avatar name={c.contact.name} size="sm" />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-fg">{c.contact.name}</span>
              <span className="truncate font-mono text-2xs text-fg-muted">{c.contact.email}</span>
            </span>
          </span>
          <dl className="hd-facts grid gap-x-2 gap-y-1">
            {c.contact.company && (
              <>
                <dt className="text-fg-muted">{t("customer.company")}</dt>
                <dd className="m-0 text-fg">
                  {c.contact.company.users !== null
                    ? t("customer.companyUsers", { name: c.contact.company.name, count: c.contact.company.users })
                    : c.contact.company.name}
                </dd>
              </>
            )}
            {c.contact.plan && (
              <>
                <dt className="text-fg-muted">{t("customer.plan")}</dt>
                <dd className="m-0 text-fg">
                  {c.contact.plan.renews ? t("customer.planRenews", { plan: c.contact.plan.name, date: date(c.contact.plan.renews) }) : c.contact.plan.name}
                </dd>
              </>
            )}
            {deal && (
              <>
                <dt className="text-fg-muted">{t("customer.openDeal")}</dt>
                <dd className="m-0 font-medium text-fg">{[deal.name, money(deal.amount, deal.currency), deal.stage].filter(Boolean).join(" · ")}</dd>
              </>
            )}
            {c.contact.owner && (
              <>
                <dt className="text-fg-muted">{t("customer.owner")}</dt>
                <dd className="m-0 text-fg">{c.contact.owner.name}</dd>
              </>
            )}
            <dt className="text-fg-muted">{t("customer.tickets")}</dt>
            <dd className="m-0 text-fg">{t("customer.ticketsValue", { count: c.tickets.year, open: c.tickets.open })}</dd>
          </dl>
          {c.contact.url && (
            <Button size="xs" variant="ghost" icon={<ExternalLink />} className="self-start" onClick={() => window.open(c.contact!.url!, "_blank", "noopener")}>
              {t("customer.open")}
            </Button>
          )}
        </div>
      )}
    </Panel>
  );
}

function ArticlesPanel({ call, number, onInsert }: { call: Call; number: number; onInsert: (text: string) => void }) {
  const t = useT();
  const [a] = useLoad<Articles>(call, `/api/v1/tickets/${number}/articles`);
  // Knowledge Base not linked: nothing is shown.
  if (!a || !a.linked) return null;
  return (
    <Panel title={t("articles.title")} description={t("articles.description")}>
      {a.error ? (
        <p className="text-xs text-fg-muted">{t("articles.unavailable")}</p>
      ) : a.articles.length === 0 ? (
        <p className="text-xs text-fg-muted">{t("articles.none")}</p>
      ) : (
        <ul aria-label={t("articles.title")} className="hd-list flex flex-col gap-1.5">
          {a.articles.map((x) => (
            <li key={x.url} className="flex items-start gap-2 text-sm">
              <FileSearch aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent-text" />
              <span className="flex min-w-0 grow flex-col">
                <a href={x.url} target="_blank" rel="noopener noreferrer" className="truncate text-fg">
                  {x.title}
                </a>
                {x.helpful !== null && <span className="text-2xs text-fg-muted">{t("articles.helpful", { share: x.helpful })}</span>}
              </span>
              <Button size="xs" variant="ghost" onClick={() => onInsert(`${x.title}: ${x.url}`)}>
                {t("articles.insert")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function TicketPage({
  call,
  number,
  settings,
  members,
  onChanged,
}: {
  call: Call;
  number: number;
  settings: Settings;
  members: Member[];
  onChanged: () => void;
}) {
  const t = useT();
  const now = useNow();
  const { can } = useAuth();
  const [ticket, reload] = useLoad<TicketDetail>(call, `/api/v1/tickets/${number}`, 30_000);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [insert, setInsert] = useState<{ text: string; n: number } | null>(null);
  const queues = settings.config!.queues;
  const owners = useMemo(() => [{ value: "", label: t("ticket.notAssigned") }, ...members.map((m) => ({ value: m.id, label: m.name }))], [members, t]);

  if (ticket === undefined) return <PageHeader title={t("loading")} />;
  if (ticket === null) return <EmptyState title={t("ticket.notFound", { number })} />;
  const editor = can("editor");
  const name = ticket.customer.name ?? ticket.customer.email ?? t("ticket.visitor");

  async function change(body: Record<string, unknown>, done?: string) {
    setError(null);
    try {
      await call(`/api/v1/tickets/${number}`, { method: "PATCH", body: JSON.stringify(body) });
      if (done) setNotice(done);
      reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function send(text: string, note: boolean, attachments: Upload[], solve: boolean): Promise<boolean> {
    setError(null);
    try {
      if (note) await call(`/api/v1/tickets/${number}/notes`, { method: "POST", body: JSON.stringify({ text }) });
      else {
        const m = await call<Message>(`/api/v1/tickets/${number}/replies`, {
          method: "POST",
          body: JSON.stringify({
            text,
            status: solve ? "solved" : "waiting",
            attachments: attachments.map(({ name: n, type, data }) => ({ name: n, type, data })),
          }),
        });
        const to = ticket!.customer.email ?? "";
        setNotice(m.delivery === "sent" ? t(solve ? "ticket.sentSolved" : "ticket.sent", { to, from: ticket!.address ?? "", name }) : null);
        setWarning(m.delivery === "sent" ? null : t("ticket.queued", { error: m.deliveryError ?? "" }));
      }
      reload();
      onChanged();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  }

  const solved = ticket.status === "solved" || ticket.status === "closed";
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: t("queue.title"), href: "/queue" }, { label: ticket.queue.name }, { label: ref(ticket.number) }]}
        title={ticket.subject}
        meta={<StatusBadge tone={statusTone(ticket.status)}>{t(`status.${ticket.status}`)}</StatusBadge>}
        actions={
          <>
            <Button icon={<ArrowLeft />} onClick={() => navigate("/queue")}>
              {t("ticket.back")}
            </Button>
            {editor &&
              (solved ? (
                <Button icon={<RotateCcw />} onClick={() => void change({ status: "open" }, t("ticket.reopenedNotice", { number: ref(number) }))}>
                  {t("ticket.reopen")}
                </Button>
              ) : (
                <Button variant="primary" onClick={() => void change({ status: "solved" }, t("ticket.solvedNotice", { number: ref(number), name }))}>
                  {t("ticket.markSolved")}
                </Button>
              ))}
          </>
        }
      />
      {notice && <Notice>{notice}</Notice>}
      {warning && (
        <Callout tone="warning" title={t("ticket.notSentYet")} className="mb-2.5">
          {warning}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" title={t("common.failed")} className="mb-2.5">
          {error}
        </Callout>
      )}
      {!ticket.canReply && !solved && (
        <Callout tone="info" title={t("ticket.cannotReply")} className="mb-2.5">
          {!ticket.customer.email ? t("ticket.noEmail") : t("ticket.noSmtp", { address: ticket.address ?? t("ticket.noAddress") })}
        </Callout>
      )}
      <div className="hd-side grid gap-2.5">
        <Panel flush aria-label={t("ticket.conversation")}>
          <ol aria-label={t("ticket.thread")} className="hd-list flex flex-col gap-2 p-3">
            {ticket.messages.map((m) => (
              <MessageItem key={m.id} m={m} address={ticket.address} />
            ))}
          </ol>
          {editor && <Composer key={ticket.number} ticket={ticket} onSend={send} insert={insert} />}
        </Panel>
        <div className="flex min-w-0 flex-col gap-2.5">
          <CustomerPanel call={call} number={number} />
          {(ticket.clocks.firstReply || ticket.clocks.solution) && (
            <Panel title="SLA" aria-label="SLA">
              <ul className="hd-list flex flex-col gap-1.5 text-xs">
                <ClockRow label={t("sla.firstReplyTarget", { target: ticket.clocks.firstReplyText ?? "" })} clock={ticket.clocks.firstReply} t={t} now={now} />
                <ClockRow label={t("sla.solutionTarget", { target: ticket.clocks.solutionText ?? "" })} clock={ticket.clocks.solution} t={t} now={now} />
              </ul>
              <p className="mt-2 text-2xs text-fg-muted">
                {ticket.hours.always
                  ? t("sla.always", { queue: ticket.queue.name })
                  : t("sla.hours", { queue: ticket.queue.name, hours: ticket.hours.text, zone: ticket.hours.timeZone })}
              </p>
            </Panel>
          )}
          <Panel title={t("ticket.properties")} aria-label={t("ticket.properties")}>
            <div className="flex flex-col gap-2">
              <SelectField
                label={t("queue.owner")}
                value={ticket.owner?.id ?? ""}
                disabled={!editor}
                onChange={(e) => void change({ owner: e.target.value || null })}
                options={owners}
              />
              <SelectField
                label={t("queue.priority")}
                value={ticket.priority}
                disabled={!editor}
                onChange={(e) => void change({ priority: e.target.value as Priority })}
                options={PRIORITIES.map((p) => ({ value: p, label: t(`priority.${p}`) }))}
              />
              <SelectField
                label={t("queue.queue")}
                value={ticket.queue.id}
                disabled={!editor}
                onChange={(e) =>
                  void change({ queue: e.target.value }, t("ticket.movedNotice", { queue: queues.find((q) => q.id === e.target.value)?.name ?? "" }))
                }
                options={[
                  ...(queues.some((q) => q.id === ticket.queue.id) ? [] : [{ value: ticket.queue.id, label: ticket.queue.name }]),
                  ...queues.map((q) => ({ value: q.id, label: q.name })),
                ]}
              />
              {!solved && editor && (
                <SelectField
                  label={t("queue.status")}
                  value={ticket.status}
                  onChange={(e) => void change({ status: e.target.value })}
                  options={(["open", "waiting"] as const).map((s) => ({ value: s, label: t(`status.${s}`) }))}
                />
              )}
              <p className="text-2xs text-fg-muted">{t("ticket.routed", { queue: ticket.queue.name, rule: ticket.routedBy })}</p>
              {ticket.follows && (
                <p className="text-2xs text-fg-muted">
                  <a href={`/tickets/${ticket.follows}`}>{t("ticket.follows", { number: ref(ticket.follows) })}</a>
                </p>
              )}
            </div>
          </Panel>
          {ticket.rating && (
            <Panel title={t("ticket.satisfaction")}>
              <p className="text-xs text-fg">
                {ticket.rating.score !== null
                  ? t("ticket.rated", { score: ticket.rating.score })
                  : t("ticket.asked", { date: ticket.rating.askedAt ? date(ticket.rating.askedAt) : "" })}
              </p>
              {ticket.rating.comment && <p className="mt-1 text-xs text-fg-muted">“{ticket.rating.comment}”</p>}
            </Panel>
          )}
          <ArticlesPanel call={call} number={number} onInsert={(text) => setInsert((x) => ({ text, n: (x?.n ?? 0) + 1 }))} />
        </div>
      </div>
    </>
  );
}
