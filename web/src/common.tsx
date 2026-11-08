// What the pages share: data loading with the session, and how times, SLAs and statuses read.
import { useAuth } from "@openasy/auth/react";
import type { Tone } from "@openasy/ui";
import { ClipboardList, Mail, MessageCircle } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, MfaSetupRequired, Unauthorized, type Channel, type Priority, type Sla, type Status, type Ticket } from "./api.ts";
import type { T } from "./i18n.ts";

/** Data loading with the session; when it ends, the sign-in screen comes back. */
export function useApi() {
  const { expired, refresh } = useAuth();
  return useCallback(
    async <R,>(path: string, init?: RequestInit): Promise<R> => {
      try {
        return await api<R>(path, init);
      } catch (err) {
        if (err instanceof Unauthorized) expired();
        if (err instanceof MfaSetupRequired) void refresh();
        throw err;
      }
    },
    [expired, refresh],
  );
}
export type Call = ReturnType<typeof useApi>;

/** Loads a path when it changes, and again every `everyMs`; `reload` loads it now. undefined while loading, null when it failed. */
export function useLoad<R>(call: Call, path: string | null, everyMs?: number) {
  const [data, setData] = useState<R | null>();
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const load = () =>
      void call<R>(path).then(
        (d) => live && setData(d),
        () => live && setData((old) => (old === undefined ? null : old)),
      );
    load();
    const timer = everyMs ? setInterval(load, everyMs) : undefined;
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [call, path, n, everyMs]);
  return [data, () => setN((x) => x + 1)] as const;
}

/** The clock, ticking once a minute, so SLA times move on screen. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** A status line after something was done, read out by screen readers. */
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="mb-2.5 rounded-md bg-success-soft px-3 py-2 text-sm text-fg">
      {children}
    </div>
  );
}

export function Code({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <pre aria-label={label} className="hd-code m-0 overflow-x-auto rounded-md bg-canvas px-2.5 py-2 font-mono text-2xs leading-relaxed text-fg">
      {children}
    </pre>
  );
}

// ---------------------------------------------------------------- Formatting

export const fmt = (n: number) => n.toLocaleString();
const MIN = 60_000;

/** A length of time as people say it: 38 min, 2 h 12 min, 1 day 2 h. */
export function duration(ms: number, t: T): string {
  const total = Math.max(0, Math.round(ms / MIN));
  const days = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (days) return h ? t("time.dayHours", { count: days, h }) : t("time.days", { count: days });
  if (h) return m ? t("time.hoursMinutes", { h, m }) : t("time.hours", { h });
  return t("time.minutes", { m });
}

export const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export const date = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** Today's time, or yesterday, or the date: how a list says when. */
export function when(iso: string, t: T, now = Date.now()) {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time(iso);
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return t("time.yesterday");
  return date(iso);
}

/** How long ago, in words and in the page's language: 3 days ago. */
export function ago(iso: string, locale?: string, now = Date.now()) {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const abs = Math.abs(s);
  if (abs < 60) return rtf.format(s, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86_400), "day");
}

export const CHANNEL_ICON: Record<Channel, typeof Mail> = { email: Mail, form: ClipboardList, chat: MessageCircle };
export const PRIORITY_TONE: Record<Priority, Tone> = { urgent: "danger", high: "warning", normal: "neutral", low: "neutral" };
export const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low"];

export function statusTone(s: Status): Tone {
  return s === "solved" || s === "closed" ? "success" : s === "waiting" ? "neutral" : "info";
}

/** The SLA as the queue shows it: "First reply in 2 h 12 min", "Solution missed 12 min ago", "Paused, waiting on customer". */
export function slaText(ticket: Pick<Ticket, "status" | "sla">, t: T, now = Date.now()): { text: string; tone: Tone; sort: number } {
  if (ticket.status === "solved" || ticket.status === "closed") return { text: t("status.solved"), tone: "success", sort: Number.MAX_SAFE_INTEGER };
  const s: Sla | null = ticket.sla;
  if (!s) return { text: t("sla.none"), tone: "neutral", sort: Number.MAX_SAFE_INTEGER - 1 };
  const which = t(`sla.${s.which}`);
  if (s.state === "missed")
    return {
      text: t("sla.missedAgo", { which, ago: duration(now - Date.parse(s.missedAt ?? s.dueAt ?? new Date(now).toISOString()), t) }),
      tone: "danger",
      sort: s.remaining,
    };
  if (s.state === "paused" || !s.dueAt) return { text: t("sla.paused"), tone: "neutral", sort: Number.MAX_SAFE_INTEGER - 2 };
  return {
    text: t("sla.dueIn", { which, left: duration(Date.parse(s.dueAt) - now, t) }),
    tone: s.remaining < 60 * MIN ? "warning" : "neutral",
    sort: s.remaining,
  };
}

/** A ticket's number as people write it. */
export const ref = (n: number) => `#${n}`;

export function money(amount: number | null, currency: string | null) {
  if (amount === null) return null;
  try {
    return new Intl.NumberFormat(undefined, { style: currency ? "currency" : "decimal", currency: currency ?? undefined, maximumFractionDigits: 0 }).format(
      amount,
    );
  } catch {
    return `${fmt(amount)} ${currency ?? ""}`.trim();
  }
}
