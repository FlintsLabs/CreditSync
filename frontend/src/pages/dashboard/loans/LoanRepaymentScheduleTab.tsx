import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { LoanTablePagination, type LoanTablePageSize } from "./LoanTablePagination";

interface ScheduleRow { id: string; publicId: string; installmentNo: number; dueDate: string; remainingDue: string; commissionAmount?: string; status: string }
interface ScheduleSummary { businessDate: string; totalInstallments: number; paidInstallments: number; overdueInstallments: number; dueTodayInstallments: number; dueTodayAmount: string; pendingInstallments: number }

function ScheduleStatus({ status, label }: { status: string; label: string }) {
    const isPaid = status === "paid";
    const isOverdue = status === "overdue";
    const isDue = ["pending", "partial", "overdue", "due", "scheduled"].includes(status);
    const Icon = isPaid ? Check : isDue ? AlertTriangle : null;
    const className = isPaid
        ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
        : isDue && !isOverdue
            ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
            : undefined;

    return <Badge
        data-testid={isPaid ? "schedule-status-paid" : isOverdue ? "schedule-status-overdue" : isDue ? "schedule-status-due" : undefined}
        variant={isOverdue ? "destructive" : "outline"}
        className={className}
    >
        {Icon && <Icon
            data-testid={isPaid ? "schedule-status-icon-paid" : "schedule-status-icon-due"}
            className="mr-1 h-3.5 w-3.5"
            aria-hidden="true"
        />}
        {label}
    </Badge>;
}

export function LoanRepaymentScheduleTab({ loanPublicId }: { loanPublicId: string }) {
    const { t, i18n } = useTranslation();
    const [rows, setRows] = useState<ScheduleRow[]>([]);
    const [totalCommission, setTotalCommission] = useState("0.00");
    const [summary, setSummary] = useState<ScheduleSummary | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<LoanTablePageSize>(10);

    useEffect(() => {
        let active = true;
        Promise.all([api.get(`/loans/${loanPublicId}/schedule`), api.get(`/loans/${loanPublicId}/schedule-summary`), api.get(`/loans/${loanPublicId}`)])
            .then(([scheduleResponse, summaryResponse, loanResponse]) => {
                if (!active) return;
                setRows(scheduleResponse.data ?? []);
                setSummary(summaryResponse.data ?? null);
                setPage(1);
                setTotalCommission(loanResponse.data?.commissionSummary?.totalCommission ?? "0.00");
                setError("");
            })
            .catch(() => { if (active) setError(t("loanDetail.scheduleTab.errors.load", "Unable to load repayment schedule.")); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [loanPublicId, t]);

    return <Card><CardHeader><CardTitle>{t("loanDetail.repaymentSchedule", "Repayment Schedule")}</CardTitle></CardHeader><CardContent>
        {error && <p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
        {loading ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("common.loading", "Loading...")}</div>
            : rows.length === 0 ? <div className="rounded border border-dashed p-5 text-sm text-muted-foreground">{t("loanDetail.noRepaymentSchedule", "No repayment schedule available for this loan.")}</div>
            : <div className="space-y-4">
                <div className="rounded border bg-muted/20 p-4"><div className="text-sm text-muted-foreground">{t("loanDetail.scheduleTab.totalCommission", "Commission generated from collected interest")}</div><div className="text-xl font-semibold tabular-nums">{formatMoneyExact(totalCommission, i18n.language)}</div></div>
                {summary && <div data-testid="schedule-summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900 dark:bg-emerald-950/20"><div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">{t("loanDetail.scheduleTab.summary.paid", "Paid")}</div><div className="mt-1 text-lg font-semibold tabular-nums">{t("loanDetail.scheduleTab.summary.paidCount", "{{paid}} / {{total}} installments", { paid: summary.paidInstallments, total: summary.totalInstallments })}</div></div>
                    <div className="rounded border border-red-200 bg-red-50/60 p-3 dark:border-red-900 dark:bg-red-950/20"><div className="text-sm font-medium text-red-700 dark:text-red-300">{t("loanDetail.scheduleTab.summary.overdue", "Overdue")}</div><div className="mt-1 text-lg font-semibold tabular-nums">{t("loanDetail.scheduleTab.summary.overdueCount", "{{count}} installments", { count: summary.overdueInstallments })}</div></div>
                    <div className="rounded border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-900 dark:bg-amber-950/20"><div className="text-sm font-medium text-amber-700 dark:text-amber-300">{t("loanDetail.scheduleTab.summary.dueToday", "Due today")}</div><div className="mt-1 text-lg font-semibold tabular-nums">{t("loanDetail.scheduleTab.summary.dueTodayCount", "{{count}} installments · {{amount}}", { count: summary.dueTodayInstallments, amount: formatMoneyExact(summary.dueTodayAmount, i18n.language) })}</div><div className="mt-1 text-xs text-muted-foreground">{t("loanDetail.scheduleTab.summary.today", "Today {{date}}", { date: summary.businessDate })}</div></div>
                    <div className="rounded border bg-muted/20 p-3"><div className="text-sm font-medium text-muted-foreground">{t("loanDetail.scheduleTab.summary.pending", "Pending")}</div><div className="mt-1 text-lg font-semibold tabular-nums">{t("loanDetail.scheduleTab.summary.pendingCount", "{{count}} installments", { count: summary.pendingInstallments })}</div></div>
                </div>}
                <div className="overflow-x-auto"><Table className="min-w-[42rem]"><TableHeader><TableRow><TableHead>{t("loanDetail.table.no", "No.")}</TableHead><TableHead>{t("loanDetail.scheduleColumns.installment")}</TableHead><TableHead>{t("loanDetail.scheduleColumns.dueDate")}</TableHead><TableHead className="text-right">{t("loanDetail.scheduleColumns.remainingDue")}</TableHead><TableHead className="text-right">{t("loanDetail.scheduleColumns.commission")}</TableHead><TableHead className="text-right">{t("loanDetail.scheduleColumns.status")}</TableHead></TableRow></TableHeader><TableBody>{rows.slice((page - 1) * (pageSize === "all" ? rows.length : pageSize), pageSize === "all" ? rows.length : page * pageSize).map((row, index) => <TableRow key={row.publicId ?? row.id}><TableCell data-testid={`schedule-row-number-${(page - 1) * (pageSize === "all" ? rows.length : pageSize) + index + 1}`}>{(page - 1) * (pageSize === "all" ? rows.length : pageSize) + index + 1}</TableCell><TableCell className="font-medium">{t("loanDetail.installmentLabel", { defaultValue: "Installment #{{id}}", id: row.installmentNo })}</TableCell><TableCell>{row.dueDate}</TableCell><TableCell className="text-right tabular-nums">{formatMoneyExact(row.remainingDue, i18n.language)}</TableCell><TableCell className="text-right tabular-nums">{formatMoneyExact(row.commissionAmount ?? "0.00", i18n.language)}</TableCell><TableCell className="text-right"><ScheduleStatus status={row.status} label={t(`loans.paymentHealth.scheduleStatus.${row.status}`, { defaultValue: row.status })} /></TableCell></TableRow>)}</TableBody></Table></div>
                <LoanTablePagination controlId="loan-schedule-page-size" page={page} pageSize={pageSize} totalItems={rows.length} onPageChange={setPage} onPageSizeChange={(nextPageSize) => { setPageSize(nextPageSize); setPage(1); }} />
            </div>}
    </CardContent></Card>;
}
