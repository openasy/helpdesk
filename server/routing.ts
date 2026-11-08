// Which queue a new ticket goes to, and its SLA targets. A ticket goes to the first queue, in the file's order, whose
// rule matches its address, channel, form, source, subject, sender's domain or the customer's plan from CRM; a queue
// with no rule takes every ticket. When no queue matches, the last queue takes it.
import { fold, type Channel, type Condition, type Config, type Queue } from "./config.ts";

export interface Arrival {
  channel: Channel;
  /** The support address an email came to. */
  address: string | null;
  /** The source id from the file, for forms and chats. */
  source: string | null;
  form: string | null;
  subject: string;
  fromEmail: string | null;
  /** The customer's plan id from CRM; null when CRM is not linked or knows no such customer. */
  plan: string | null;
}

export interface Routed {
  queue: Queue;
  /** Why: `subject has "invoice"`, `plan business`, or `no rule matched`. */
  rule: string;
  firstReply: number | null;
  solution: number | null;
}

const words = (s: string) => ` ${fold(s).replace(/[^\p{L}\p{N}]+/gu, " ")} `;

/** The reason a rule matches, or null when it does not. Every condition in the rule must hold. */
export function matches(c: Condition, a: Arrival): string | null {
  const why: string[] = [];
  if (c.address) {
    if (!a.address || !c.address.includes(a.address)) return null;
    why.push(`address ${a.address}`);
  }
  if (c.channel) {
    if (!c.channel.includes(a.channel)) return null;
    why.push(`channel ${a.channel}`);
  }
  if (c.source) {
    if (!a.source || !c.source.includes(a.source)) return null;
    why.push(`source ${a.source}`);
  }
  if (c.form) {
    if (!a.form || !c.form.includes(a.form)) return null;
    why.push(`form ${a.form}`);
  }
  if (c.subjectHas) {
    const subject = words(a.subject);
    // A word or a phrase, at the start of a word: "fatura" finds "Faturalar", "invoice" finds "invoices".
    const hit = c.subjectHas.find((w) => subject.includes(` ${w}`));
    if (!hit) return null;
    why.push(`subject has "${hit}"`);
  }
  if (c.fromDomain) {
    const domain = a.fromEmail?.split("@")[1] ?? "";
    const hit = c.fromDomain.find((d) => domain === d || domain.endsWith(`.${d}`));
    if (!hit) return null;
    why.push(`from ${hit}`);
  }
  if (c.plan) {
    if (!a.plan || !c.plan.includes(a.plan.toLowerCase())) return null;
    why.push(`plan ${a.plan}`);
  }
  return why.join(", ");
}

/** The SLA targets for a ticket in a queue, with the customer's plan over the queue's own. */
export function targetsFor(queue: Queue, plan: string | null): { firstReply: number | null; solution: number | null } {
  const over = plan ? queue.slaByPlan[plan.toLowerCase()] : undefined;
  const pick = (k: "firstReply" | "solution") => (over && k in over ? (over[k]?.ms ?? null) : (queue.sla[k]?.ms ?? null));
  return { firstReply: pick("firstReply"), solution: pick("solution") };
}

export function route(config: Config, a: Arrival): Routed {
  for (const queue of config.queues) {
    let rule: string | null = null;
    if (queue.match === null) rule = "every ticket";
    else
      for (const c of queue.match) {
        rule = matches(c, a);
        if (rule !== null) break;
      }
    if (rule !== null) return { queue, rule, ...targetsFor(queue, a.plan) };
  }
  const queue = config.queues.at(-1)!;
  return { queue, rule: "no rule matched", ...targetsFor(queue, a.plan) };
}
