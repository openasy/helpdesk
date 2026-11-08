// The UI is an ordinary client of the public API (ADR 0014, 0018). Types follow openapi.json.

export interface ProductLink {
  id: string;
  url: string;
}

/** The settings file and whether it is applied; null before it was first read. */
export type ConfigFile = {
  path: string;
  appliedAt: string | null;
  error: string | null;
  warnings: string[];
} | null;

export type Channel = "email" | "form" | "chat";
export type Status = "open" | "waiting" | "solved" | "closed";
export type Priority = "urgent" | "high" | "normal" | "low";
export type ClockState = "running" | "paused" | "met" | "missed";

export interface Sla {
  which: "firstReply" | "solution";
  state: ClockState;
  remaining: number;
  dueAt: string | null;
  missedAt: string | null;
}

export interface Ticket {
  number: number;
  subject: string;
  status: Status;
  priority: Priority;
  queue: { id: string; name: string };
  channel: Channel;
  customer: { email: string | null; name: string | null };
  owner: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  sla: Sla | null;
  satisfaction: number | null;
}

export interface Clock {
  target: number;
  state: ClockState;
  elapsed: number;
  remaining: number;
  dueAt: string | null;
  missedAt: string | null;
  doneAt: string | null;
}

export interface Message {
  id: string;
  kind: "customer" | "agent" | "note" | "system";
  via: "email" | "form" | "chat" | "web" | "helpdesk";
  author: { id: string | null; name: string; email: string | null };
  at: string;
  subject: string | null;
  body: string;
  fullText: string | null;
  html: string | null;
  to: string[];
  cc: string[];
  delivery: "queued" | "sent" | "failed" | null;
  deliveryError: string | null;
  event: string | null;
  data: Record<string, unknown> | null;
  attachments: Array<{ id: string; filename: string; contentType: string; size: number }>;
}

export interface TicketDetail extends Ticket {
  address: string | null;
  canReply: boolean;
  source: string;
  form: string | null;
  routedBy: string;
  plan: string | null;
  follows: number | null;
  firstReplyAt: string | null;
  solvedAt: string | null;
  clocks: { firstReply: Clock | null; solution: Clock | null; firstReplyText: string | null; solutionText: string | null };
  hours: { always: boolean; text: string; timeZone: string; described: string };
  satisfaction: number | null;
  rating: { askedAt: string | null; score: number | null; comment: string | null; at: string | null } | null;
  messages: Message[];
  answers: Array<{ id: string; title: string; text: string }>;
}

export interface CrmContact {
  id: string;
  name: string;
  email: string;
  title: string | null;
  company: { name: string; users: number | null } | null;
  plan: { id: string; name: string; renews: string | null } | null;
  owner: { name: string; email: string | null } | null;
  url: string | null;
}

export interface CrmDeal {
  id: string;
  name: string;
  amount: number | null;
  currency: string | null;
  stage: string | null;
  status: "open" | "won" | "lost";
  url: string | null;
}

export type Customer =
  | { linked: false }
  | {
      linked: true;
      email: string | null;
      tickets: { year: number; open: number };
      found: boolean;
      error: string | null;
      contact: CrmContact | null;
      deals: CrmDeal[];
    };

export interface Articles {
  linked: boolean;
  articles: Array<{ title: string; excerpt: string; url: string; helpful: number | null }>;
  error: string | null;
}

export interface Member {
  id: string;
  name: string;
  email: string;
}

export interface Overview {
  file: ConfigFile;
  open: number;
  waiting: number;
  unassigned: number;
  missedNow: number;
  queues: Array<{ id: string; name: string; open: number; waiting: number }>;
  atRisk: Ticket[];
  at: string;
}

export interface Report {
  days: number;
  from: string;
  timeZone: string;
  totals: {
    opened: number;
    openedBefore: number;
    solved: number;
    firstReply: number | null;
    firstReplyBefore: number | null;
    solvedIn: number | null;
    slaMet: number;
    slaMissed: number;
    satisfaction: number | null;
    answers: number;
  };
  series: Array<{ day: string; opened: number; solved: number }>;
  byQueue: Array<{
    id: string;
    name: string;
    tickets: number;
    firstReply: number | null;
    solvedIn: number | null;
    slaMet: number;
    slaMissed: number;
    satisfaction: number | null;
    answers: number;
  }>;
  byChannel: Array<{ channel: Channel; tickets: number }>;
  arrivals: number[][];
}

export interface Target {
  ms: number;
  text: string;
}

export interface Config {
  support: { name: string; language: string; timeZone: string; holidays: string[]; reopenWithin: number; acknowledge: boolean; maxNewPerHour: number };
  mail: { checkEvery: number; replyToken: "subject" | "address" | "both" };
  addresses: Array<{
    address: string;
    name: string;
    user: string;
    password: string;
    folder: string;
    imap: { host: string; port: number; tls: boolean } | null;
    smtp: { host: string; port: number; tls: boolean } | null;
  }>;
  queues: Array<{
    id: string;
    name: string;
    match: Array<Record<string, string[]>> | null;
    hours: { always: boolean; timeZone: string; described: string };
    hoursText: string;
    sla: { firstReply: Target | null; solution: Target | null };
    slaByPlan: Record<string, { firstReply?: Target | null; solution?: Target | null }>;
    priority: Priority;
  }>;
  satisfaction: { askAfter: number | null };
  answers: Array<{ id: string; title: string; text: string; queues: string[] }>;
  sources: Array<{ id: string; name: string; channel: "form" | "chat"; key: string | null; origins: string[]; address: string | null }>;
  crm: { url: string; token: string } | null;
  knowledgeBase: { url: string; language: string | null } | null;
}

export interface Settings {
  config: Config | null;
  yaml: string;
  file: ConfigFile;
}

export interface MailState {
  addresses: Array<{
    address: string;
    name: string;
    reading: boolean;
    sending: boolean;
    passwordSet: boolean;
    checkedAt: string | null;
    okAt: string | null;
    error: string | null;
    ignored: number;
  }>;
  outbox: { queued: number; failed: number };
  ignored: Array<{ at: string; address: string; sender: string | null; subject: string | null; reason: string }>;
}

export class Unauthorized extends Error {}
/** The signed-in owner or admin has no second factor yet; the sign-in gate asks for one. */
export class MfaSetupRequired extends Error {}
export class ApiError extends Error {}

// The session is an HttpOnly cookie set by sign-in (@openasy/auth); the browser sends it, nothing is stored here.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string; detail?: string };
    if (res.status === 401) throw new Unauthorized(problem.detail);
    if (problem.code === "mfa-setup-required") throw new MfaSetupRequired(problem.detail);
    throw new ApiError(problem.detail ?? `${path}: ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}
