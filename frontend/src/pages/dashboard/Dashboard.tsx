import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  BanknoteArrowDown,
  BanknoteArrowUp,
  CircleDollarSign,
  RefreshCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { formatMoneyExact } from "../../lib/workflow-model";
import { getStoredUser, isTenantAdminUser } from "../../lib/session";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/Button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../components/ui/Card";
import {
    buildDashboardPriorities,
    buildBorrowerRepaymentHref,
  compareMoney,
  type BorrowerDueItem,
  type DashboardPriority,
  type DashboardSummary,
  type FundDueItem,
  type FundingAlerts,
  type ProfitabilitySummary,
  type ReconciliationStatus,
} from "./dashboard-model";

type Resource<T> = { data: T | null; loading: boolean; error: boolean };

const QUEUE_SECTION_CLASS = "min-w-0 rounded-none border-0 bg-transparent shadow-none md:rounded-lg md:border md:bg-card md:text-card-foreground md:shadow-sm";
const QUEUE_HEADER_CLASS = "px-0 pb-3 pt-0 md:p-6";
const QUEUE_CONTENT_CLASS = "divide-y divide-border/70 p-0 md:px-6 md:pb-6";
const QUEUE_ROW_CLASS = "group flex min-h-16 w-full items-center justify-between gap-3 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:px-3";

function useDashboardResource<T>(path: string, fallback: T) {
  const fallbackRef = useRef(fallback);
  const [state, setState] = useState<Resource<T>>({
    data: null,
    loading: true,
    error: false,
  });
  useEffect(() => {
    let active = true;
    void api
      .get(path)
      .then((response) => {
        if (active)
          setState({
            data: response.data ?? fallbackRef.current,
            loading: false,
            error: false,
          });
      })
      .catch((error) => {
        console.error(`Failed to load dashboard resource ${path}`, error);
        if (active) setState({ data: null, loading: false, error: true });
      });
    return () => {
      active = false;
    };
  }, [path]);
  const retry = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: false }));
    try {
      const response = await api.get(path);
      setState({
        data: response.data ?? fallbackRef.current,
        loading: false,
        error: false,
      });
    } catch (error) {
      console.error(`Failed to load dashboard resource ${path}`, error);
      setState((current) => ({ ...current, loading: false, error: true }));
    }
  }, [path]);
  return { ...state, retry };
}

function Skeleton({ className = "h-8 w-28" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-muted ${className}`}
      aria-hidden="true"
    />
  );
}

function SectionError({ retry }: { retry: () => Promise<void> }) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-sm"
    >
      <span className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-destructive" />
        {t("dashboardPage.errors.section")}
      </span>
      <Button size="sm" variant="outline" onClick={() => void retry()}>
        <RefreshCw className="mr-2 h-3.5 w-3.5" />
        {t("dashboardPage.actions.retry")}
      </Button>
    </div>
  );
}

function MoneyMetric({
  label,
  value,
  icon,
  tone = "default",
}: {
  label: string;
  value: string;
  icon: ReactNode;
  tone?: "default" | "positive" | "negative";
}) {
  const { i18n } = useTranslation();
  const color =
    tone === "positive"
      ? "text-emerald-500"
      : tone === "negative"
        ? "text-destructive"
        : "text-foreground";
  return (
    <div className="min-w-0 border-b border-border/70 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div
        className={`mt-2 truncate text-xl font-semibold tabular-nums sm:text-2xl ${color}`}
      >
        {formatMoneyExact(value, i18n.language)}
      </div>
    </div>
  );
}

function PriorityRow({
  item,
  onOpen,
}: {
  item: DashboardPriority;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const tone =
    item.tone === "danger"
      ? "border-destructive/30 bg-destructive/5"
      : item.tone === "warning"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-primary/20 bg-primary/5";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group flex w-full items-center gap-3 rounded-xl border p-3 text-left transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-sm ${tone}`}
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-background font-semibold tabular-nums shadow-sm">
        {item.count}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">
          {t(`dashboardPage.priorities.${item.key}.title`)}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {t(`dashboardPage.priorities.${item.key}.description`)}
        </span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const overdue = status === "overdue";
  return (
    <Badge variant={overdue ? "destructive" : "secondary"}>
      {t(`dashboardPage.status.${status}`, {
        defaultValue: t("dashboardPage.status.pending"),
      })}
    </Badge>
  );
}

export function BorrowerQueueMeta({ item }: { item: BorrowerDueItem }) {
  const { t, i18n } = useTranslation();
  if (item.repaymentType === "floating") {
    return (
      <span className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>{t("dashboardPage.floatingOverdueItems", { count: item.overdueItemCount ?? 0 })}</span>
        <span>{t("dashboardPage.floatingMaxOverdueDays", { count: item.overdueDays ?? 0 })}</span>
      </span>
    );
  }
  if (!item.dueDate) return null;
  const dueDate = new Intl.DateTimeFormat(i18n.language, { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${item.dueDate}T00:00:00`));
  return <span className="block text-xs text-muted-foreground">{t("dashboardPage.installment", { number: item.installmentNo })} · {dueDate}</span>;
}

export default function Dashboard() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const currentUser = getStoredUser();
  const isTenantAdmin = isTenantAdminUser(currentUser);
  const [showAllBorrowers, setShowAllBorrowers] = useState(false);
  const [showAllFunds, setShowAllFunds] = useState(false);

  const summary = useDashboardResource<DashboardSummary>("/dashboard/summary", {
    dueFromBorrowersToday: "0.00",
    dueToFundsToday: "0.00",
    netPositionToday: "0.00",
    overdueBorrowerCount: 0,
    overdueFundCount: 0,
    underfundedLoanCount: 0,
    unallocatedDrawdownCount: 0,
  });
  const borrowerQueue = useDashboardResource<BorrowerDueItem[]>(
    "/dashboard/borrower-due-queue",
    [],
  );
  const fundQueue = useDashboardResource<FundDueItem[]>(
    "/dashboard/fund-due-queue",
    [],
  );
  const alerts = useDashboardResource<FundingAlerts>(
    "/dashboard/funding-alerts",
    { underfundedLoans: [], unallocatedDrawdowns: [] },
  );
  const reconciliation = useDashboardResource<ReconciliationStatus>(
    "/dashboard/reconciliation-status",
    {
      unreconciledBorrowerPayments: 0,
      recordedFundRepayments: 0,
      fundRepaymentsMissingScheduleLink: 0,
      pendingBankImports: 0,
      pendingManualReviews: 0,
      borrowerPaymentsMissingSlip: 0,
    },
  );
  const profitability = useDashboardResource<ProfitabilitySummary>(
    "/dashboard/profitability-summary",
    {
      borrowerRevenueCollected: "0.00",
      fundCostPaid: "0.00",
      realizedSpread: "0.00",
      unrealizedSpread: "0.00",
      deployedPrincipal: "0.00",
      netCashPosition: "0.00",
      realizedRoiPercent: "0.00",
      carryForwardAvailable: "0.00",
    },
  );

  useEffect(() => {
    if (!isTenantAdmin) navigate("/loans", { replace: true });
  }, [isTenantAdmin, navigate]);
  const priorities = useMemo(
    () =>
      buildDashboardPriorities({
        summary: summary.data,
        reconciliation: reconciliation.data,
      }),
    [summary.data, reconciliation.data],
  );
  const netTone =
    compareMoney(summary.data?.netPositionToday ?? "0.00", "0.00") < 0
      ? "negative"
      : "positive";
  const formatDate = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(`${value}T00:00:00`));
  const openBorrower = (item: BorrowerDueItem) =>
    navigate(buildBorrowerRepaymentHref(item));
  const openFund = (item: FundDueItem) =>
    item.bankProfilePublicId || item.bankProfileId
      ? navigate(
          `/funds/${item.bankProfilePublicId ?? item.bankProfileId}?bankLoanId=${item.bankLoanPublicId ?? item.bankLoanId}&scheduleId=${item.schedulePublicId ?? item.scheduleId}`,
        )
      : navigate("/funds");

  if (!isTenantAdmin) return null;
  return (
    <main
      className="flex-1 space-y-6 pb-10"
      aria-labelledby="dashboard-title"
    >
      <header className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            <Sparkles className="h-4 w-4" />
            {t("dashboardPage.eyebrow")}
          </div>
          <h1
            id="dashboard-title"
            className="text-3xl font-bold tracking-tight sm:text-4xl"
          >
            {t("dashboardPage.title")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground sm:text-base">
            {t("dashboardPage.description")}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button
            className="col-span-2"
            onClick={() => navigate("/transactions/new")}
          >
            <CircleDollarSign className="mr-2 h-4 w-4" />
            {t("dashboardPage.actions.recordBorrowerPayment")}
          </Button>
          <Button variant="outline" onClick={() => navigate("/matching")}>
            {t("dashboardPage.actions.openMatching")}
          </Button>
          <Button variant="outline" onClick={() => navigate("/funds")}>
            {t("dashboardPage.actions.openFunds")}
          </Button>
        </div>
      </header>

      <section
        aria-labelledby="cash-heading"
        className="overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-primary/5 shadow-sm"
      >
        <div className="flex items-center justify-between border-b border-border/70 px-5 py-4">
          <div>
            <h2 id="cash-heading" className="font-semibold">
              {t("dashboardPage.sections.cashToday")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("dashboardPage.sections.cashTodayDescription")}
            </p>
          </div>
          <Badge variant="secondary">{t("dashboardPage.live")}</Badge>
        </div>
        <div
          className="grid sm:grid-cols-3"
          aria-busy={summary.loading}
        >
          {summary.error ? (
            <div className="sm:col-span-3">
              <SectionError retry={summary.retry} />
            </div>
          ) : summary.loading ? (
            <>
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </>
          ) : (
            <>
              <MoneyMetric
                label={t("dashboardPage.cards.dueFromBorrowers")}
                value={summary.data?.dueFromBorrowersToday ?? "0.00"}
                icon={
                  <BanknoteArrowDown className="h-4 w-4 text-emerald-500" />
                }
              />
              <MoneyMetric
                label={t("dashboardPage.cards.dueToFunds")}
                value={summary.data?.dueToFundsToday ?? "0.00"}
                icon={<BanknoteArrowUp className="h-4 w-4 text-amber-500" />}
              />
              <MoneyMetric
                label={t("dashboardPage.cards.netPosition")}
                value={summary.data?.netPositionToday ?? "0.00"}
                tone={netTone}
                icon={<CircleDollarSign className="h-4 w-4" />}
              />
            </>
          )}
        </div>
      </section>

      <div className="grid min-w-0 grid-cols-1 gap-6 xl:grid-cols-[minmax(0,0.88fr)_minmax(0,1.4fr)]">
        <Card className="h-fit border-primary/20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-primary" />
              {t("dashboardPage.sections.priorities")}
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              {t("dashboardPage.sections.prioritiesDescription")}
            </p>
          </CardHeader>
          <CardContent
            className="space-y-2"
            aria-busy={summary.loading || reconciliation.loading}
          >
            {summary.error && reconciliation.error ? (
              <SectionError
                retry={async () => {
                  await Promise.all([summary.retry(), reconciliation.retry()]);
                }}
              />
            ) : priorities.length ? (
              priorities.map((item) => (
                <PriorityRow
                  key={item.key}
                  item={item}
                  onOpen={() => navigate(item.href)}
                />
              ))
            ) : summary.loading || reconciliation.loading ? (
              <>
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </>
            ) : (
              <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t("dashboardPage.empty.noPriorities")}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-2">
          <Card className={QUEUE_SECTION_CLASS}>
            <CardHeader className={`flex flex-row items-start justify-between gap-3 ${QUEUE_HEADER_CLASS}`}>
              <div>
                <CardTitle>
                  {t("dashboardPage.sections.borrowerDueQueue")}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("dashboardPage.sections.borrowerDueDescription")}
                </p>
              </div>
              <Badge>{borrowerQueue.data?.length ?? 0}</Badge>
            </CardHeader>
            <CardContent
              className={QUEUE_CONTENT_CLASS}
              aria-busy={borrowerQueue.loading}
            >
              {borrowerQueue.error ? (
                <SectionError retry={borrowerQueue.retry} />
              ) : borrowerQueue.loading ? (
                <>
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </>
              ) : borrowerQueue.data?.length ? (
                <>
                  {borrowerQueue.data
                    .slice(0, showAllBorrowers ? undefined : 5)
                    .map((item) => (
                      <button
                        key={`${item.repaymentType}-${item.schedulePublicId ?? item.scheduleId ?? item.loanPublicId ?? item.loanId}`}
                        type="button"
                        onClick={() => openBorrower(item)}
                        className={QUEUE_ROW_CLASS}
                      >
                        <span className="min-w-0 flex-1 pr-2">
                          <span className="block truncate font-medium">
                            {item.borrowerName}
                          </span>
                          <BorrowerQueueMeta item={item} />
                        </span>
                        <span className="shrink-0 space-y-1 text-right">
                          <span className="block font-semibold tabular-nums">
                            {formatMoneyExact(
                              item.totalDueNow ?? item.remainingDue,
                              i18n.language,
                            )}
                          </span>
                          <StatusBadge status={item.status} />
                        </span>
                      </button>
                    ))}
                  {borrowerQueue.data.length > 5 && (
                    <Button
                      className="w-full"
                      variant="ghost"
                      onClick={() => setShowAllBorrowers((value) => !value)}
                    >
                      {showAllBorrowers
                        ? t("dashboardPage.actions.showLess")
                        : t("dashboardPage.actions.viewAll", {
                            count: borrowerQueue.data.length,
                          })}
                    </Button>
                  )}
                </>
              ) : (
                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("dashboardPage.empty.noBorrowerDue")}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={QUEUE_SECTION_CLASS}>
            <CardHeader className={`flex flex-row items-start justify-between gap-3 ${QUEUE_HEADER_CLASS}`}>
              <div>
                <CardTitle>
                  {t("dashboardPage.sections.fundDueQueue")}
                </CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("dashboardPage.sections.fundDueDescription")}
                </p>
              </div>
              <Badge>{fundQueue.data?.length ?? 0}</Badge>
            </CardHeader>
            <CardContent className={QUEUE_CONTENT_CLASS} aria-busy={fundQueue.loading}>
              {fundQueue.error ? (
                <SectionError retry={fundQueue.retry} />
              ) : fundQueue.loading ? (
                <>
                  <Skeleton className="h-20 w-full" />
                  <Skeleton className="h-20 w-full" />
                </>
              ) : fundQueue.data?.length ? (
                <>
                  {fundQueue.data
                    .slice(0, showAllFunds ? undefined : 5)
                    .map((item) => (
                      <button
                        key={item.scheduleId}
                        type="button"
                        onClick={() => openFund(item)}
                        className={QUEUE_ROW_CLASS}
                      >
                        <span className="min-w-0 flex-1 pr-2">
                          <span className="block truncate font-medium">
                            {t("dashboardPage.drawdownLabel", {
                              id: item.bankLoanId,
                            })}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            {t("dashboardPage.installment", {
                              number: item.installmentNo,
                            })}{" "}
                            · {formatDate(item.dueDate)}
                          </span>
                        </span>
                        <span className="shrink-0 space-y-1 text-right">
                          <span className="block font-semibold tabular-nums">
                            {formatMoneyExact(
                              item.totalDueNow ?? item.remainingDue,
                              i18n.language,
                            )}
                          </span>
                          <StatusBadge status={item.status} />
                        </span>
                      </button>
                    ))}
                  {fundQueue.data.length > 5 && (
                    <Button
                      className="w-full"
                      variant="ghost"
                      onClick={() => setShowAllFunds((value) => !value)}
                    >
                      {showAllFunds
                        ? t("dashboardPage.actions.showLess")
                        : t("dashboardPage.actions.viewAll", {
                            count: fundQueue.data.length,
                          })}
                    </Button>
                  )}
                </>
              ) : (
                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                  {t("dashboardPage.empty.noFundDue")}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <section aria-labelledby="details-heading">
        <div className="mb-3">
          <h2 id="details-heading" className="text-lg font-semibold">
            {t("dashboardPage.sections.details")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("dashboardPage.sections.detailsDescription")}
          </p>
        </div>
        <div className="hidden gap-4 md:grid md:grid-cols-3">
          <DetailCards
            alerts={alerts}
            reconciliation={reconciliation}
            profitability={profitability}
          />
        </div>
        <details className="rounded-xl border bg-card p-4 md:hidden">
          <summary className="cursor-pointer font-medium">
            {t("dashboardPage.actions.openDetails")}
          </summary>
          <div className="mt-4 space-y-4">
            <DetailCards
              alerts={alerts}
              reconciliation={reconciliation}
              profitability={profitability}
            />
          </div>
        </details>
      </section>
    </main>
  );
}

function DetailCards({
  alerts,
  reconciliation,
  profitability,
}: {
  alerts: ReturnType<typeof useDashboardResource<FundingAlerts>>;
  reconciliation: ReturnType<typeof useDashboardResource<ReconciliationStatus>>;
  profitability: ReturnType<typeof useDashboardResource<ProfitabilitySummary>>;
}) {
  const { t, i18n } = useTranslation();
  const items = [
    {
      key: "underfunded",
      label: t("dashboardPage.sections.underfundedLoans"),
      value: alerts.data?.underfundedLoans.length ?? 0,
    },
    {
      key: "unallocated",
      label: t("dashboardPage.sections.unallocatedDrawdowns"),
      value: alerts.data?.unallocatedDrawdowns.length ?? 0,
    },
    {
      key: "unmatched",
      label: t("dashboardPage.reconciliation.unmatchedBorrowerPayments"),
      value: reconciliation.data?.unreconciledBorrowerPayments ?? 0,
    },
  ];
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("dashboardPage.sections.fundingAlerts")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {alerts.error ? (
            <SectionError retry={alerts.retry} />
          ) : alerts.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            items.slice(0, 2).map((item) => (
              <div key={item.key} className="flex justify-between text-sm">
                <span className="text-muted-foreground">{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("dashboardPage.sections.reconciliationStatus")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {reconciliation.error ? (
            <SectionError retry={reconciliation.retry} />
          ) : reconciliation.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              {items.slice(2).map((item) => (
                <div key={item.key} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("dashboardPage.reconciliation.pendingManualReviews")}
                </span>
                <strong>
                  {reconciliation.data?.pendingManualReviews ?? 0}
                </strong>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("dashboardPage.sections.profitability")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {profitability.error ? (
            <SectionError retry={profitability.retry} />
          ) : profitability.loading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <>
              <div className="flex justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t("dashboardPage.cards.realizedSpread")}
                </span>
                <strong className="tabular-nums">
                  {formatMoneyExact(
                    profitability.data?.realizedSpread ?? "0.00",
                    i18n.language,
                  )}
                </strong>
              </div>
              <div className="flex justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t("dashboardPage.cards.unrealizedSpread")}
                </span>
                <strong className="tabular-nums">
                  {formatMoneyExact(
                    profitability.data?.unrealizedSpread ?? "0.00",
                    i18n.language,
                  )}
                </strong>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
