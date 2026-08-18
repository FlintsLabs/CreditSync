import { AlertTriangle, CalendarClock } from "lucide-react";
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
                className="space-y-1.5 rounded-lg border border-destructive/20 bg-destructive/10 p-2.5 dark:bg-destructive/15 dark:border-destructive/30"
                role="status"
                aria-label={t("loans.paymentHealth.overdueAria")}
            >
                <div className="flex items-center gap-2">
                    <Badge variant="destructive" className="gap-1 shadow-none">
                        <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
                        <span>{t(countKey, { count: health.overdueItemCount })}</span>
                    </Badge>
                </div>
                <p className="text-xs font-semibold text-destructive tabular-nums">
                    {t("loans.paymentHealth.overdueSummary", {
                        amount: formatMoneyExact(health.overdueAmount, i18n.language),
                        days: health.maxOverdueDays,
                    })}
                </p>
            </div>
        );
    }

    return (
        <Badge className="gap-1 border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200" role="status">
            <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
            {t("loans.paymentHealth.dueNow", {
                amount: formatMoneyExact(health.dueTodayAmount, i18n.language),
            })}
        </Badge>
    );
}
