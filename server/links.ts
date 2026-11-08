// The other products a ticket shows: the customer and their deals from CRM, and articles from Knowledge Base. Each is
// behind a small interface, so a test or another directory can stand in, and each is off until the file links it.
//
// CRM is matched by the customer's email address and nothing else: no names, no domains, no guessing. Helpdesk asks
//   GET <crm.url>/api/v1/lookup?email=<address>      Authorization: Bearer <the key crm.token names>
// and takes 200 with { contact, deals } (CrmCustomer below) or 404 when no contact has that address. README.md
// describes it for CRM's side.

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

export interface CrmCustomer {
  contact: CrmContact;
  deals: CrmDeal[];
}

/** Finds the CRM contact with exactly this email address, or null. Throws when CRM cannot be asked. */
export interface CustomerDirectory {
  lookup(email: string): Promise<CrmCustomer | null>;
}

export interface SuggestedArticle {
  title: string;
  excerpt: string;
  url: string;
  helpful: number | null;
}

/** Articles for what a ticket is about. Throws when Knowledge Base cannot be asked. */
export interface ArticleSuggester {
  suggest(text: string, lang: string | null): Promise<SuggestedArticle[]>;
}

const str = (v: unknown, max = 300): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const link = (v: unknown): string | null => {
  const u = typeof v === "string" ? URL.parse(v) : null;
  return u && (u.protocol === "https:" || u.protocol === "http:") ? u.href : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** CRM's answer, keeping only fields of the right type; another product's answer is not trusted further than that. */
export function readCustomer(body: unknown, email: string): CrmCustomer | null {
  const b = obj(body);
  const c = obj(b?.contact);
  const id = str(c?.id, 200);
  if (!c || !id) return null;
  // Matched by email only: an answer for another address is not this customer.
  const found = str(c.email, 254)?.toLowerCase();
  if (found && found !== email) return null;
  const company = obj(c.company);
  const plan = obj(c.plan);
  const owner = obj(c.owner);
  const users = company && typeof company.users === "number" && Number.isFinite(company.users) ? company.users : null;
  const deals = (Array.isArray(b!.deals) ? b!.deals : []).slice(0, 20).flatMap((d): CrmDeal[] => {
    const x = obj(d);
    const did = str(x?.id, 200);
    const name = str(x?.name);
    if (!x || !did || !name) return [];
    const status = x.status === "won" || x.status === "lost" ? x.status : "open";
    return [
      {
        id: did,
        name,
        amount: typeof x.amount === "number" && Number.isFinite(x.amount) ? x.amount : null,
        currency: str(x.currency, 3)?.toUpperCase() ?? null,
        stage: str(x.stage, 80),
        status,
        url: link(x.url),
      },
    ];
  });
  return {
    contact: {
      id,
      name: str(c.name) ?? email,
      email,
      title: str(c.title),
      company: company && str(company.name) ? { name: str(company.name)!, users } : null,
      plan: plan && str(plan.id, 64) ? { id: str(plan.id, 64)!, name: str(plan.name) ?? str(plan.id, 64)!, renews: str(plan.renews, 30) } : null,
      owner: owner && str(owner.name) ? { name: str(owner.name)!, email: str(owner.email, 254) } : null,
      url: link(c.url),
    },
    deals,
  };
}

export function crmDirectory(o: { url: string; token: string | undefined; fetch?: typeof fetch; timeoutMs?: number }): CustomerDirectory {
  const call = o.fetch ?? fetch;
  return {
    async lookup(email) {
      const res = await call(`${o.url}/api/v1/lookup?${new URLSearchParams({ email })}`, {
        headers: { accept: "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
        signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
        redirect: "error",
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`CRM answered ${res.status}`);
      return readCustomer(await res.json(), email);
    },
  };
}

export function kbSuggester(o: { url: string; fetch?: typeof fetch; timeoutMs?: number }): ArticleSuggester {
  const call = o.fetch ?? fetch;
  return {
    async suggest(text, lang) {
      const q = new URLSearchParams({ q: text.slice(0, 200), place: "helpdesk-agent", limit: "3", ...(lang ? { lang } : {}) });
      const res = await call(`${o.url}/api/v1/suggest?${q}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(o.timeoutMs ?? 3000),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`Knowledge Base answered ${res.status}`);
      const body = obj(await res.json());
      return (Array.isArray(body?.articles) ? body.articles : []).slice(0, 5).flatMap((a): SuggestedArticle[] => {
        const x = obj(a);
        const title = str(x?.title);
        const url = link(x?.url);
        if (!x || !title || !url) return [];
        return [{ title, url, excerpt: str(x.excerpt, 300) ?? "", helpful: typeof x.helpful === "number" ? x.helpful : null }];
      });
    },
  };
}
