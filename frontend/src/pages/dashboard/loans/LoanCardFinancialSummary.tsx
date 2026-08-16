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
            <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-green-600">
                    <CircleCheck aria-hidden="true" className="h-5 w-5" />
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
        <div className="space-y-1">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <div className="text-2xl font-bold tabular-nums">{formatMoneyExact(outstandingPrincipal, i18n.language)}</div>
                <p className="text-xs text-muted-foreground">/ {t("loans.originalPrincipal")} {formatMoneyExact(originalPrincipal, i18n.language)}</p>
            </div>
            <p className="text-xs text-muted-foreground tabular-nums">
                {t("loans.interestReceived")} {formatMoneyExact(interestReceived, i18n.language)}
                {" · "}
                {t("loans.paidToDate")} {formatMoneyExact(paidToDate, i18n.language)}
            </p>
            <p className={cn("text-xs font-semibold uppercase", status === "active" ? "text-green-600" : "text-gray-500")}>{status}</p>
        </div>
    );
}
