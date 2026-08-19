import { AlertTriangle, CalendarClock, Wallet } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../../components/ui/badge";
import { formatMoneyExact } from "../../../lib/workflow-model";

export interface LoanPaymentHealth {
    status: "current" | "due_today" | "overdue" | "settled";
    dueTodayAmount: string;
    overdueAmount: string;
    overdueItemCount: number;
    maxOverdueDays: number;
}
interface Props {
    health: LoanPaymentHealth;
    repaymentType: string;
}

export function LoanPaymentHealthBadge({ health, repaymentType }: Props) {
    const { t, i18n } = useTranslation();
    if (health.status === "current" || health.status === "settled") return null;

    if (health.status === "overdue") {
        const countKey = repaymentType === "floating"
            ? "loans.paymentHealth.overdueDays"
            : "loans.paymentHealth.overdueInstallments";
        return (
            <div
                className="space-y-2 rounded-xl border border-destructive/25 bg-red-50/70 p-3 dark:border-destructive/30 dark:bg-destructive/10"
                role="status"
                aria-label={t("loans.paymentHealth.overdueAria")}
            >
                <div className="flex items-center gap-2">
                    <Badge variant="destructive" className="gap-1.5 px-2 py-0.5 text-xs font-semibold shadow-none rounded-md">
                        <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
                        <span>{t(countKey, { count: health.overdueItemCount })}</span>
                    </Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1.5 border-t border-destructive/15">
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="p-1 rounded-md bg-destructive/10 text-destructive shrink-0">
                            <Wallet className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                            <div className="text-xs sm:text-sm font-bold text-destructive tabular-nums truncate">
                                {formatMoneyExact(health.overdueAmount, i18n.language)}
                            </div>
                            <div className="text-[10px] sm:text-[11px] text-muted-foreground truncate">
                                {t("loans.paymentHealth.totalOverdue", "Total overdue balance")}
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="p-1 rounded-md bg-destructive/10 text-destructive shrink-0">
                            <CalendarClock className="h-3.5 w-3.5" />
                        </div>
                        <div className="min-w-0">
                            <div className="text-xs sm:text-sm font-bold text-destructive tabular-nums truncate">
                                {t("loans.paymentHealth.daysCount", { count: health.maxOverdueDays, defaultValue: `${health.maxOverdueDays} days` })}
                            </div>
                            <div className="text-[10px] sm:text-[11px] text-muted-foreground truncate">
                                {t("loans.paymentHealth.maxOverdueDaysLabel", "Max overdue days")}
                            </div>
                        </div>
                    </div>
                </div>
                <p className="text-xs font-semibold text-destructive tabular-nums pt-1 border-t border-destructive/15">
                    {t("loans.paymentHealth.overdueSummary", {
                        amount: formatMoneyExact(health.overdueAmount, i18n.language),
                        days: health.maxOverdueDays,
                    })}
                </p>
            </div>
        );
    }

    return (
        <div className="flex items-center justify-between rounded-xl border border-amber-300/60 bg-amber-50/80 p-2.5 dark:border-amber-900/40 dark:bg-amber-950/20" role="status">
            <Badge className="gap-1 border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200 font-semibold shadow-none" role="status">
                <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
                {t("loans.paymentHealth.dueNow", {
                    amount: formatMoneyExact(health.dueTodayAmount, i18n.language),
                })}
            </Badge>
        </div>
    );
}
