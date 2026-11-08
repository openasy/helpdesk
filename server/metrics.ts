// Prometheus text exposition, written by hand: a few lines, no client library needed.
import { counters } from "./helpdesk.ts";

const requests = new Map<string, number>();

export function countRequest(method: string, route: string, status: number) {
  const key = `method="${method}",route="${route}",status="${status}"`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export interface Gauges {
  /** Tickets by status: open, waiting, solved, closed. */
  tickets: Record<string, number>;
  /** Open and waiting tickets whose SLA clock passed its target. */
  missed: number;
  /** Emails waiting in the outbox to be sent or tried again. */
  outbox: number;
  /** Support addresses whose last reading failed. */
  mailboxErrors: number;
  /** 1 when the settings file on disk could not be applied and an older version is in use. */
  fileError: boolean;
}

export function renderMetrics(version: string, g: Gauges): string {
  const lines = [
    "# HELP openasy_build_info Build information.",
    "# TYPE openasy_build_info gauge",
    `openasy_build_info{product="helpdesk",version="${version}"} 1`,
    "# HELP openasy_http_requests_total HTTP requests handled.",
    "# TYPE openasy_http_requests_total counter",
    ...[...requests].map(([labels, n]) => `openasy_http_requests_total{${labels}} ${n}`),
    "# HELP openasy_helpdesk_tickets Tickets, by status.",
    "# TYPE openasy_helpdesk_tickets gauge",
    ...["open", "waiting", "solved", "closed"].map((s) => `openasy_helpdesk_tickets{status="${s}"} ${g.tickets[s] ?? 0}`),
    "# HELP openasy_helpdesk_sla_missed Open and waiting tickets whose SLA is missed.",
    "# TYPE openasy_helpdesk_sla_missed gauge",
    `openasy_helpdesk_sla_missed ${g.missed}`,
    "# HELP openasy_helpdesk_mail_received_total Emails, forms and chats read, by what they became: ticket, reply, form, chat, ignored or duplicate.",
    "# TYPE openasy_helpdesk_mail_received_total counter",
    ...[...counters.received].map(([result, n]) => `openasy_helpdesk_mail_received_total{result="${result}"} ${n}`),
    "# HELP openasy_helpdesk_mail_sent_total Emails sent, by result: sent, retry or failed.",
    "# TYPE openasy_helpdesk_mail_sent_total counter",
    ...[...counters.sent].map(([result, n]) => `openasy_helpdesk_mail_sent_total{result="${result}"} ${n}`),
    "# HELP openasy_helpdesk_outbox Emails waiting to be sent.",
    "# TYPE openasy_helpdesk_outbox gauge",
    `openasy_helpdesk_outbox ${g.outbox}`,
    "# HELP openasy_helpdesk_mailbox_errors Support addresses whose mail could not be read the last time.",
    "# TYPE openasy_helpdesk_mailbox_errors gauge",
    `openasy_helpdesk_mailbox_errors ${g.mailboxErrors}`,
    "# HELP openasy_helpdesk_config_error 1 when the settings file could not be applied and its last good version is in use.",
    "# TYPE openasy_helpdesk_config_error gauge",
    `openasy_helpdesk_config_error ${g.fileError ? 1 : 0}`,
    "# HELP process_uptime_seconds Seconds since the process started.",
    "# TYPE process_uptime_seconds gauge",
    `process_uptime_seconds ${process.uptime().toFixed(0)}`,
  ];
  return lines.join("\n") + "\n";
}
