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
            <div className="space-y-1.5 rounded-lg bg-muted/40 p-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                    <CircleCheck aria-hidden="true" className="h-5 w-5 shrink-0" />
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
        <div className="space-y-1.5 rounded-lg bg-muted/40 p-3">
            <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground font-medium">{t("loans.outstandingPrincipal", "Outstanding Principal")}</span>
                <p className={cn("text-xs font-semibold uppercase", status === "active" ? "text-green-600 dark:text-green-400" : "text-gray-500 dark:text-gray-400")}>
                    {status === "replaced" ? t("loans.status.replaced") : status}
                </p>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <div className="text-xl font-bold tracking-tight tabular-nums text-foreground">{formatMoneyExact(outstandingPrincipal, i18n.language)}</div>
                <p className="text-xs text-muted-foreground">/ {t("loans.originalPrincipal")} {formatMoneyExact(originalPrincipal, i18n.language)}</p>
            </div>
            <p className="text-xs text-muted-foreground tabular-nums pt-0.5 border-t border-border/50">
                {t("loans.interestReceived")} {formatMoneyExact(interestReceived, i18n.language)}
                {" · "}
                {t("loans.paidToDate")} {formatMoneyExact(paidToDate, i18n.language)}
            </p>
        </div>
    );
}
