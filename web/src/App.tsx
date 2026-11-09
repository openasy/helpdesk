import {
  AppShell,
  BrandProvider,
  Button,
  Callout,
  EmptyState,
  navigate,
  PageHeader,
  PRODUCT_IDS,
  toLocale,
  usePath,
  useLocalePreference,
  useThemePreference,
  type ProductId,
} from "@openasy/ui";
import { AccountSettings, AuthGate, MembersSettings, SignInSettings, TokensSettings, useAccountMenu, useAuth, useInstallBrand } from "@openasy/auth/react";
import colophon from "virtual:openasy-colophon";
import {
  BarChart3,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogIn,
  LogOut,
  Plug,
  Settings as SettingsIcon,
  Ticket as TicketIcon,
  UserRound,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Member, Overview, ProductLink, Settings, Ticket } from "./api.ts";
import { ref, useApi } from "./common.tsx";
import { useT, setViewerLocale } from "./i18n.ts";
import { IntegrationsPage, OverviewPage, ReportsPage, SettingsFilePage } from "./pages.tsx";
import { QueuePage, TicketPage } from "./tickets.tsx";

const PAGES = ["queue", "reports", "integrations", "settings", "account", "members", "signin", "tokens"] as const;
type Route = { page: "overview" | (typeof PAGES)[number] } | { page: "ticket"; number: number };
/** The first path segments that are pages of this UI, for followLinks. */
export const PATHS = ["overview", "tickets", ...PAGES];
function parseRoute(path: string): Route {
  const [page, id] = path.replace(/^\//, "").split("/");
  if (page === "tickets" && id && /^\d+$/.test(id)) return { page: "ticket", number: Number(id) };
  if ((PAGES as readonly string[]).includes(page ?? "")) return { page: page as (typeof PAGES)[number] };
  return { page: "overview" };
}

/** Account, Members, Sign-in and API tokens: the screens come from @openasy/auth. */
function AuthSettingsPage({ page }: { page: "account" | "members" | "signin" | "tokens" }) {
  const t = useT();
  const { signOut, can } = useAuth();
  if (page !== "account" && !can("admin")) return <EmptyState title={t("auth.adminsOnly")}>{t("auth.askAnAdmin")}</EmptyState>;
  return (
    <>
      <PageHeader
        title={t(`auth.${page}`)}
        description={t(`auth.${page}Detail`)}
        actions={
          page === "account" && (
            <Button icon={<LogOut />} onClick={() => void signOut()}>
              {t("auth.signOut")}
            </Button>
          )
        }
      />
      {page === "account" ? <AccountSettings /> : page === "members" ? <MembersSettings /> : page === "signin" ? <SignInSettings /> : <TokensSettings />}
    </>
  );
}

function Product() {
  const msg = useT();
  const [theme, setTheme] = useThemePreference();
  const [, setLocale] = useLocalePreference();
  const { me, can } = useAuth();
  const account = useAccountMenu();
  const route = parseRoute(usePath());
  const [overview, setOverview] = useState<Overview>();
  const [settings, setSettings] = useState<Settings>();
  const [members, setMembers] = useState<Member[]>([]);
  const [products, setProducts] = useState<Array<ProductLink & { id: ProductId }>>([]);
  const call = useApi();

  // The install's other products (OPENASY_PRODUCTS), for the switcher; ids this UI does not know are left out.
  useEffect(() => {
    void call<{ products: ProductLink[] }>("/api/v1/products").then(
      (r) =>
        setProducts(r.products.filter((p): p is ProductLink & { id: ProductId } => p.id !== "helpdesk" && (PRODUCT_IDS as readonly string[]).includes(p.id))),
      () => {},
    );
    void call<{ members: Member[] }>("/api/v1/team").then(
      (r) => setMembers(r.members),
      () => {},
    );
  }, [call]);

  const reload = useCallback(() => {
    void call<Overview>("/api/v1/overview").then(setOverview, () => {});
    void call<Settings>("/api/v1/settings").then(setSettings, () => {});
  }, [call]);
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 60_000);
    return () => clearInterval(timer);
  }, [reload]);

  // The search window (Cmd+K) finds tickets by number, subject or customer.
  const onSearch = useMemo(
    () => async (q: string, signal: AbortSignal) => {
      const r = await call<{ tickets: Ticket[] }>(`/api/v1/tickets?${new URLSearchParams({ q, limit: "10" })}`, { signal });
      return r.tickets.map((x) => ({
        id: `ticket:${x.number}`,
        label: `${ref(x.number)} ${x.subject}`,
        detail: `${x.customer.name ?? x.customer.email ?? ""} · ${msg(`status.${x.status}`)}`,
        kind: msg("search.ticket"),
        icon: TicketIcon,
        href: `/tickets/${x.number}`,
      }));
    },
    [call, msg],
  );

  const nav = [
    { id: "overview", label: msg("nav.overview"), icon: LayoutDashboard },
    { id: "queue", label: msg("nav.queues"), icon: Inbox, count: overview?.open || undefined },
    { id: "reports", label: msg("nav.reports"), icon: BarChart3 },
  ];
  const footerNav = [
    { id: "integrations", label: msg("nav.integrations"), icon: Plug },
    { id: "settings", label: msg("nav.settings"), icon: SettingsIcon },
    ...(can("admin")
      ? [
          { id: "members", label: msg("nav.members"), icon: Users },
          { id: "signin", label: msg("nav.signIn"), icon: LogIn },
          { id: "tokens", label: msg("nav.apiTokens"), icon: KeyRound },
        ]
      : []),
    { id: "account", label: msg("nav.account"), icon: UserRound },
  ];
  const active = route.page === "ticket" ? "queue" : route.page;
  const roleName = me.user.role.charAt(0).toUpperCase() + me.user.role.slice(1);
  const ready = settings?.config ? settings : undefined;

  return (
    <AppShell
      product="helpdesk"
      onSearch={onSearch}
      about={colophon}
      nav={nav}
      activeNav={active}
      onNavigate={(id) => navigate(`/${id}`)}
      connectedProducts={products.map((p) => p.id)}
      onSwitchProduct={(id) => {
        const to = products.find((p) => p.id === id);
        if (to) window.location.assign(to.url);
      }}
      footerNav={account.settings(footerNav)}
      user={{ name: me.user.name, role: roleName, ...account.user }}
      theme={theme}
      onThemeChange={setTheme}
      onLanguageChange={(code) => setLocale(toLocale(code))}
    >
      {overview?.file?.error && route.page !== "settings" && (
        <Callout tone="danger" title={msg("file.notApplied")} className="mb-2.5">
          {overview.file.error}
        </Callout>
      )}
      {route.page === "account" || route.page === "members" || route.page === "signin" || route.page === "tokens" ? (
        <AuthSettingsPage page={route.page} />
      ) : !ready ? (
        <PageHeader title={msg("loading")} />
      ) : route.page === "queue" ? (
        <QueuePage call={call} settings={ready} onChanged={reload} />
      ) : route.page === "ticket" ? (
        <TicketPage key={route.number} call={call} number={route.number} settings={ready} members={members} onChanged={reload} />
      ) : route.page === "reports" ? (
        <ReportsPage call={call} />
      ) : route.page === "integrations" ? (
        <IntegrationsPage call={call} settings={ready} />
      ) : route.page === "settings" ? (
        <SettingsFilePage settings={ready} />
      ) : (
        <OverviewPage call={call} />
      )}
    </AppShell>
  );
}

export function App() {
  const installBrand = useInstallBrand();
  const [theme] = useThemePreference();
  const [locale] = useLocalePreference();
  setViewerLocale(locale);
  return (
    // The install's brand from config/brand.env (ADR 0053); OpenAsy's own look where it sets none.
    <BrandProvider theme={theme} locale={locale} brand={{ name: "OpenAsy", organization: undefined, ...installBrand }} className="min-h-screen">
      <AuthGate product="OpenAsy Helpdesk">
        <Product />
      </AuthGate>
    </BrandProvider>
  );
}
