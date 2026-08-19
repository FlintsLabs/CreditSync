import { CircleCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../lib/utils";
import { formatMoneyExact } from "../../../lib/workflow-model";

export interface LoanCardFinancialSummaryProps {
    status: string;
    outstandingPrincipal: string;
    originalPrincipal: string;
    interestReceived: string;
    paidToDate: string;
}
export function LoanCardFinancialSummary({
    status,
    outstandingPrincipal,
    originalPrincipal,
    interestReceived,
    paidToDate,
}: LoanCardFinancialSummaryProps) {
    const { t, i18n } = useTranslation();

    if (status === "paid") {
        return (
            <div className="space-y-1.5 rounded-xl border border-emerald-200/70 bg-emerald-50/50 p-3 sm:p-3.5 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                    <CircleCheck aria-hidden="true" className="h-4 w-4 shrink-0" />
                    <span>{t("loans.paidComplete")}</span>
                </div>
                <p className="text-xs text-muted-foreground tabular-nums">
                    {t("loans.originalPrincipal")} {formatMoneyExact(originalPrincipal, i18n.language)}
                    {" · "}
                    {t("loans.interestReceived")} {formatMoneyExact(interestReceived, i18n.language)}
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-2 rounded-xl border border-border/50 bg-muted/15 p-3 sm:p-3.5">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground font-medium">{t("loans.outstandingPrincipal", "Outstanding Principal")}</span>
                <p className={cn("text-xs font-semibold uppercase tracking-wider", status === "active" ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
                    {status === "replaced" ? t("loans.status.replaced") : status === "restructured" ? t("loans.status.restructured") : status}
                </p>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <div className="text-xl sm:text-2xl font-bold tracking-tight tabular-nums text-foreground">{formatMoneyExact(outstandingPrincipal, i18n.language)}</div>
                <p className="text-xs text-muted-foreground">/ {t("loans.originalPrincipal")} {formatMoneyExact(originalPrincipal, i18n.language)}</p>
            </div>
            <p className="text-xs text-muted-foreground tabular-nums pt-2 border-t border-border/40">
                {t("loans.interestReceived")} {formatMoneyExact(interestReceived, i18n.language)}
                {" · "}
                {t("loans.paidToDate")} {formatMoneyExact(paidToDate, i18n.language)}
            </p>
        </div>
    );
}
