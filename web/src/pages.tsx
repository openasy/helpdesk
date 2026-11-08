// Overview, Reports, Integrations and the read-only Settings page.
import { useAuth } from "@openasy/auth/react";
import {
  BarList,
  Button,
  Callout,
  DataTable,
  EmptyState,
  Heatmap,
  KpiCard,
  KpiGrid,
  PageHeader,
  Panel,
  StatusBadge,
  Tabs,
  TimeSeriesChart,
  type Column,
  useLocalePreference,
} from "@openasy/ui";
import { Inbox, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { MailState, Overview, Report, Settings } from "./api.ts";
import { ago, Code, duration, fmt, ref, slaText, useLoad, useNow, type Call } from "./common.tsx";
import { FileSettingsPage } from "./FileSettings.tsx";
import { useT, type T } from "./i18n.ts";

const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
const share = (met: number, missed: number) => (met + missed ? Math.round((met / (met + missed)) * 1000) / 10 : null);
/** Monday first, in the page's language. */
const weekdays = () =>
  Array.from({ length: 7 }, (_, i) => new Date(Date.UTC(2026, 10, 2 + i)).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }));

// ---------------------------------------------------------------- Overview

export function OverviewPage({ call }: { call: Call }) {
  const t = useT();
  const now = useNow();
  const [o] = useLoad<Overview>(call, "/api/v1/overview", 30_000);
  const [r] = useLoad<Report>(call, "/api/v1/report?days=30");
  if (o === null || r === null) return <EmptyState title={t("common.loadFailed")} />;
  if (!o || !r) return <PageHeader title={t("overview.title")} />;
  const met = share(r.totals.slaMet, r.totals.slaMissed);
  const frDelta = r.totals.firstReply !== null && r.totals.firstReplyBefore !== null ? r.totals.firstReply - r.totals.firstReplyBefore : null;
  const firstMissed = o.atRisk.find((x) => x.sla?.state === "missed");
  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")} />
      <KpiGrid minWidth={170} className="mb-2.5">
        <KpiCard
          label={t("overview.open")}
          value={fmt(o.open)}
          icon={Inbox}
          delta={{ label: t("overview.unassigned", { count: o.unassigned }), intent: "neutral" }}
        />
        <KpiCard
          label={t("overview.firstReply")}
          value={r.totals.firstReply === null ? "–" : duration(r.totals.firstReply, t)}
          unit={t("overview.median")}
          delta={
            frDelta === null
              ? { label: t("overview.noReplies"), intent: "neutral" }
              : {
                  label: t("overview.vsBefore", { change: `${frDelta > 0 ? "+" : frDelta < 0 ? "-" : ""}${duration(Math.abs(frDelta), t)}` }),
                  direction: frDelta > 0 ? "up" : frDelta < 0 ? "down" : "flat",
                  intent: frDelta <= 0 ? "good" : "bad",
                }
          }
        />
        <KpiCard
          label={t("overview.slasMet")}
          value={met === null ? "–" : `${met}%`}
          delta={{ label: t("overview.missedIn", { count: r.totals.slaMissed }), intent: "neutral" }}
        />
        <KpiCard
          label={t("overview.missedNow")}
          value={fmt(o.missedNow)}
          tone={o.missedNow ? "danger" : undefined}
          delta={
            firstMissed
              ? { label: `${ref(firstMissed.number)}, ${firstMissed.queue.name}`, intent: "bad" }
              : { label: t("overview.noneMissed"), intent: "good" }
          }
        />
        <KpiCard
          label={t("overview.satisfaction")}
          value={r.totals.satisfaction === null ? "–" : String(r.totals.satisfaction)}
          unit={t("overview.ofFive")}
          delta={{ label: t("overview.answers", { count: r.totals.answers }), intent: "neutral" }}
        />
      </KpiGrid>
      <div className="hd-side mb-2.5 grid gap-2.5">
        <Panel title={t("overview.perDay")} description={t("overview.perDayDetail")}>
          <TimeSeriesChart
            label={t("overview.perDayLabel")}
            labels={r.series.map((d) => shortDay(d.day))}
            height={200}
            area={false}
            xTicks={7}
            format={(v) => fmt(Math.round(v))}
            series={[
              { id: "opened", name: t("overview.opened"), data: r.series.map((d) => d.opened), color: "var(--oa-chart-1)" },
              { id: "solved", name: t("overview.solved"), data: r.series.map((d) => d.solved), color: "var(--oa-success)" },
            ]}
          />
        </Panel>
        <Panel title={t("overview.byQueue")}>
          <BarList label={t("overview.byQueueLabel")} items={o.queues.map((q) => ({ id: q.id, label: q.name, value: q.open }))} />
        </Panel>
      </div>
      <Panel title={t("overview.atRisk")} description={t("overview.atRiskDetail")} flush>
        {o.atRisk.length ? (
          <ul aria-label={t("overview.atRisk")} className="hd-list flex flex-col">
            {o.atRisk.map((x) => {
              const d = slaText(x, t, now);
              return (
                <li key={x.number} className="hd-row flex items-center gap-3 border-b border-subtle px-3 py-2">
                  <span className="w-12 font-mono text-xs text-fg-muted">{ref(x.number)}</span>
                  <a href={`/tickets/${x.number}`} className="flex min-w-0 grow flex-col no-underline">
                    <span className="truncate text-sm text-fg">{x.subject}</span>
                    <span className="text-2xs text-fg-muted">
                      {x.queue.name} · {x.owner?.name ?? t("ticket.notAssigned")}
                    </span>
                  </a>
                  <StatusBadge tone={d.tone}>{d.text}</StatusBadge>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-3 py-3 text-sm text-fg-muted">{t("overview.noneAtRisk")}</p>
        )}
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- Reports

function busiest(r: Report, t: T) {
  const total = r.arrivals.flat().reduce((a, b) => a + b, 0);
  if (total < 5) return null;
  let best = { day: 0, from: 0, n: 0 };
  for (let d = 0; d < 7; d++)
    for (let h = 0; h <= 20; h++) {
      const n = r.arrivals[d]!.slice(h, h + 4).reduce((a, b) => a + b, 0);
      if (n > best.n) best = { day: d, from: h, n };
    }
  return t("reports.busiest", {
    day: weekdays()[best.day]!,
    from: String(best.from).padStart(2, "0"),
    to: String(best.from + 4).padStart(2, "0"),
    share: Math.round((best.n / total) * 100),
  });
}

export function ReportsPage({ call }: { call: Call }) {
  const t = useT();
  const [days, setDays] = useState<"7" | "30" | "90">("90");
  const [r] = useLoad<Report>(call, `/api/v1/report?days=${days}`);
  type Row = Report["byQueue"][number];
  const cols: Column<Row>[] = [
    { id: "queue", header: t("queue.queue"), sortValue: (q) => q.name, cell: (q) => <span className="font-medium">{q.name}</span> },
    { id: "tickets", header: t("reports.tickets"), align: "right", mono: true, sortValue: (q) => q.tickets, cell: (q) => fmt(q.tickets) },
    {
      id: "first",
      header: t("reports.firstReply"),
      align: "right",
      sortValue: (q) => q.firstReply ?? -1,
      cell: (q) => <span className="text-xs">{q.firstReply === null ? "–" : duration(q.firstReply, t)}</span>,
    },
    {
      id: "solve",
      header: t("reports.solvedIn"),
      align: "right",
      sortValue: (q) => q.solvedIn ?? -1,
      cell: (q) => <span className="text-xs">{q.solvedIn === null ? "–" : duration(q.solvedIn, t)}</span>,
    },
    {
      id: "met",
      header: t("reports.slasMet"),
      align: "right",
      sortValue: (q) => share(q.slaMet, q.slaMissed) ?? -1,
      cell: (q) => {
        const s = share(q.slaMet, q.slaMissed);
        return <span className={`font-mono text-xs ${s !== null && s < 92 ? "font-semibold text-warning-text" : ""}`}>{s === null ? "–" : `${s}%`}</span>;
      },
    },
    { id: "missed", header: t("reports.missed"), align: "right", mono: true, sortValue: (q) => q.slaMissed, cell: (q) => fmt(q.slaMissed) },
    {
      id: "csat",
      header: t("reports.satisfaction"),
      align: "right",
      mono: true,
      sortValue: (q) => q.satisfaction ?? -1,
      cell: (q) => (q.satisfaction === null ? "–" : `${q.satisfaction} / 5`),
    },
  ];
  // The hours anything arrived in, at least 08:00 to 19:00.
  const used = r ? [...Array(24).keys()].filter((h) => r.arrivals.some((d) => d[h]! > 0)) : [];
  const from = Math.min(8, ...used);
  const to = Math.max(19, ...used);
  const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const insight = r ? busiest(r, t) : null;
  return (
    <>
      <PageHeader title={t("reports.title")} description={t("reports.description", { days })}>
        <Tabs
          label={t("reports.period")}
          value={days}
          onChange={setDays}
          items={(["7", "30", "90"] as const).map((d) => ({ value: d, label: t("reports.days", { count: Number(d) }) }))}
        />
      </PageHeader>
      {r === null && <EmptyState title={t("common.loadFailed")} />}
      {r && (
        <>
          <div className="hd-halves mb-2.5 grid gap-2.5">
            <Panel title={t("reports.arrive")} description={t("reports.arriveDetail", { zone: r.timeZone })}>
              <Heatmap
                label={t("reports.arriveLabel")}
                rows={weekdays()}
                columns={hours.map((h) => String(h).padStart(2, "0"))}
                values={r.arrivals.map((d) => hours.map((h) => d[h]!))}
                unit={` ${t("reports.ticketsUnit")}`}
              />
            </Panel>
            <Panel title={t("reports.from")} description={t("reports.days", { count: r.days })}>
              <BarList
                label={t("reports.fromLabel")}
                items={r.byChannel.map((c) => ({ id: c.channel, label: t(`reports.channel.${c.channel}`), value: c.tickets }))}
              />
              {insight && (
                <Callout tone="info" title={t("reports.busiestTitle")} className="mt-3">
                  {insight}
                </Callout>
              )}
            </Panel>
          </div>
          <Panel flush title={t("reports.byQueue")}>
            <DataTable label={t("reports.byQueue")} columns={cols} rows={r.byQueue} getRowId={(q) => q.id} minWidth={720} />
          </Panel>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Integrations

export function IntegrationsPage({ call, settings }: { call: Call; settings: Settings }) {
  const t = useT();
  const { can } = useAuth();
  const [locale] = useLocalePreference();
  const [mail, reload] = useLoad<MailState>(call, "/api/v1/mail", 60_000);
  const [checking, setChecking] = useState(false);
  const origin = window.location.origin;
  const c = settings.config!;
  const form = c.sources.find((s) => s.channel === "form" && s.origins.length);
  const keyed = c.sources.find((s) => s.key);
  const check = async () => {
    setChecking(true);
    await call("/api/v1/mail/check", { method: "POST" }).catch(() => {});
    setChecking(false);
    reload();
  };
  return (
    <>
      <PageHeader
        title={t("integrations.title")}
        description={t("integrations.description")}
        actions={
          can("admin") &&
          c.addresses.length > 0 && (
            <Button icon={<RefreshCw />} disabled={checking} onClick={() => void check()}>
              {t("integrations.checkNow")}
            </Button>
          )
        }
      />
      <div className="hd-halves grid gap-2.5">
        <Panel title={t("integrations.email")} description={t("integrations.emailDetail")} flush>
          {c.addresses.length === 0 ? (
            <p className="px-3 py-3 text-sm text-fg-muted">{t("integrations.noAddresses")}</p>
          ) : (
            <ul aria-label={t("integrations.email")} className="hd-list flex flex-col">
              {c.addresses.map((a) => {
                const s = mail?.addresses.find((x) => x.address === a.address);
                const tone = !a.imap ? "neutral" : !s?.passwordSet || s?.error ? "danger" : s?.okAt ? "success" : "neutral";
                const label = !a.imap
                  ? t("integrations.notRead")
                  : !s?.passwordSet
                    ? t("integrations.noPassword", { name: a.password })
                    : s.error
                      ? t("integrations.failing")
                      : s.okAt
                        ? t("integrations.read", { when: ago(s.okAt, locale) })
                        : t("integrations.notYet");
                return (
                  <li key={a.address} className="hd-row flex flex-col gap-0.5 border-b border-subtle px-3 py-2">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-fg">{a.address}</span>
                      <StatusBadge tone={tone}>{label}</StatusBadge>
                    </span>
                    <span className="text-2xs text-fg-muted">
                      {a.imap ? `IMAP ${a.imap.host}:${a.imap.port}${a.imap.tls ? " TLS" : " STARTTLS"} · ${a.folder}` : t("integrations.notRead")} ·{" "}
                      {a.smtp ? `SMTP ${a.smtp.host}:${a.smtp.port}` : t("integrations.notSent")}
                    </span>
                    {s?.error && <span className="text-2xs text-danger-text">{s.error}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {mail && (mail.outbox.queued > 0 || mail.outbox.failed > 0) && (
            <p className="px-3 py-2 text-xs text-fg-muted">{t("integrations.outbox", { queued: mail.outbox.queued, failed: mail.outbox.failed })}</p>
          )}
        </Panel>
        <Panel title={t("integrations.ignored")} description={t("integrations.ignoredDetail")} flush>
          {mail?.ignored.length ? (
            <ul aria-label={t("integrations.ignored")} className="hd-list flex flex-col">
              {mail.ignored.map((x, i) => (
                <li key={`${x.at}-${i}`} className="hd-row flex flex-col border-b border-subtle px-3 py-1.5">
                  <span className="truncate text-xs text-fg">
                    {x.sender ?? "?"} · {x.subject || t("integrations.noSubject")}
                  </span>
                  <span className="text-2xs text-fg-muted">
                    {ago(x.at, locale)} · {x.reason}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-3 text-sm text-fg-muted">{t("integrations.noneIgnored")}</p>
          )}
        </Panel>
        <Panel title={t("integrations.forms")} description={t("integrations.formsDetail")}>
          <Code label={t("integrations.forms")}>{`curl -X POST ${origin}/api/v1/public/tickets \\
  -H "Authorization: Bearer $${keyed?.key ?? "HELPDESK_FORMS_KEY"}" \\
  -H "content-type: application/json" \\
  -d '{"email":"gizem@example.com","name":"Gizem","subject":"Invoices fail","message":"...","external_id":"form-123"}'`}</Code>
          {form && (
            <>
              <p className="mt-2 text-xs text-fg-muted">{t("integrations.htmlForm", { origins: form.origins.join(", ") })}</p>
              <Code label={t("integrations.htmlFormLabel")}>{`<form method="post" action="${origin}/api/v1/public/tickets">
  <input type="hidden" name="source" value="${form.id}">
  <input type="hidden" name="redirect" value="${form.origins[0]}/thanks">
  <input name="email" type="email" required> <input name="subject">
  <textarea name="message" required></textarea>
  <input name="website" hidden tabindex="-1" autocomplete="off">
  <button>Send</button>
</form>`}</Code>
            </>
          )}
          <ul aria-label={t("integrations.sources")} className="hd-list mt-2 flex flex-col gap-1 text-xs">
            {c.sources.map((s) => (
              <li key={s.id}>
                <span className="font-mono">{s.id}</span> · {t(`channel.${s.channel}`)}
                {s.key ? ` · ${t("integrations.key", { name: s.key })}` : ""}
                {s.origins.length ? ` · ${s.origins.join(", ")}` : ""}
              </li>
            ))}
            {c.sources.length === 0 && <li className="text-fg-muted">{t("integrations.noSources")}</li>}
          </ul>
        </Panel>
        <Panel title={t("integrations.crm")} description={c.crm ? t("integrations.crmOn", { url: c.crm.url }) : t("integrations.crmOff")}>
          <Code label={t("integrations.crm")}>{`GET ${c.crm?.url ?? "https://crm.example.com"}/api/v1/lookup?email=<address>
Authorization: Bearer $${c.crm?.token ?? "HELPDESK_CRM_TOKEN"}

200 { "contact": { "id", "name", "email", "company", "plan", "owner", "url" }, "deals": [...] }
404 when no contact has exactly that address`}</Code>
        </Panel>
        <Panel title={t("integrations.kb")} description={c.knowledgeBase ? t("integrations.kbOn", { url: c.knowledgeBase.url }) : t("integrations.kbOff")}>
          <Code label={t("integrations.kb")}>{`knowledge_base:
  url: https://kb.example.com
  language: ${c.knowledgeBase?.language ?? "en"}`}</Code>
        </Panel>
        <Panel title={t("integrations.api")} description={t("integrations.apiDetail")}>
          <p className="text-xs">
            <a href="/api/docs/">{t("integrations.reference")}</a>
          </p>
        </Panel>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- Settings

export function SettingsFilePage({ settings }: { settings: Settings }) {
  const t = useT();
  const c = settings.config!;
  const [locale] = useLocalePreference();
  const file = settings.file;
  const name = file?.path.split("/").pop() ?? "helpdesk.yaml";
  const targets = (q: (typeof c.queues)[number]) => {
    const parts = [
      q.sla.firstReply ? t("settings.firstReply", { target: q.sla.firstReply.text }) : null,
      q.sla.solution ? t("settings.solution", { target: q.sla.solution.text }) : null,
      ...Object.entries(q.slaByPlan).map(([plan, x]) =>
        t("settings.forPlan", {
          plan,
          targets: [
            x.firstReply ? t("settings.firstReply", { target: x.firstReply.text }) : null,
            x.solution ? t("settings.solution", { target: x.solution.text }) : null,
          ]
            .filter(Boolean)
            .join(", "),
        }),
      ),
      q.hours.always ? t("settings.always") : `${q.hoursText} (${q.hours.timeZone})`,
    ];
    return parts.filter(Boolean).join("; ");
  };
  const rule = (q: (typeof c.queues)[number]) =>
    q.match === null
      ? t("settings.everyTicket")
      : q.match
          .map((m) =>
            Object.entries(m)
              // The file's names: subject_has, not subjectHas.
              .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}: ${v.join(", ")}`)
              .join(" + "),
          )
          .join(t("settings.or"));
  return (
    <FileSettingsPage
      file={name}
      applied={file?.appliedAt ? ago(file.appliedAt, locale) : t("settings.notYet")}
      yaml={settings.yaml || t("settings.noFile")}
      problems={
        file && (file.error || file.warnings.length > 0) ? (
          <Callout tone={file.error ? "danger" : "warning"} title={file.error ? t("settings.notApplied") : t("settings.warnings")} className="mb-2.5">
            <ul className="hd-list flex flex-col gap-1">
              {[...(file.error ? [file.error] : []), ...file.warnings].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : undefined
      }
      groups={[
        {
          title: t("settings.addresses"),
          items: c.addresses.length
            ? c.addresses.map((a, i) => ({ label: a.name, value: <span className="font-mono">{a.address}</span>, path: `addresses[${i}]` }))
            : [{ label: t("settings.addresses"), value: t("settings.none"), path: "addresses" }],
        },
        {
          title: t("settings.queues"),
          description: t("settings.queuesDetail"),
          items: c.queues.map((q) => ({
            label: q.name,
            value: (
              <span className="flex flex-col">
                <span>{targets(q)}</span>
                <span className="text-2xs text-fg-muted">{rule(q)}</span>
              </span>
            ),
            path: `queues.${q.id}`,
          })),
        },
        {
          title: t("settings.support"),
          items: [
            { label: t("settings.name"), value: c.support.name, path: "support.name" },
            { label: t("settings.timeZone"), value: c.support.timeZone, path: "support.time_zone" },
            { label: t("settings.holidays"), value: c.support.holidays.length ? c.support.holidays.join(", ") : t("settings.none"), path: "support.holidays" },
            { label: t("settings.reopen"), value: duration(c.support.reopenWithin, t), path: "support.reopen_within" },
            { label: t("settings.acknowledge"), value: c.support.acknowledge ? t("settings.yes") : t("settings.no"), path: "support.acknowledge" },
            { label: t("settings.replyToken"), value: t(`settings.token.${c.mail.replyToken}`), path: "mail.reply_token" },
          ],
        },
        {
          title: t("settings.satisfaction"),
          items: [
            {
              label: t("settings.ask"),
              value: c.satisfaction.askAfter === null ? t("settings.never") : t("settings.askAfter", { after: duration(c.satisfaction.askAfter, t) }),
              path: "satisfaction.ask_after_solved",
            },
          ],
        },
        {
          title: t("settings.links"),
          items: [
            { label: "CRM", value: c.crm?.url ?? t("settings.notLinked"), path: "crm.url" },
            { label: "Knowledge Base", value: c.knowledgeBase?.url ?? t("settings.notLinked"), path: "knowledge_base.url" },
            { label: t("settings.answers"), value: c.answers.length ? c.answers.map((a) => a.title).join(", ") : t("settings.none"), path: "answers" },
          ],
        },
      ]}
    />
  );
}
