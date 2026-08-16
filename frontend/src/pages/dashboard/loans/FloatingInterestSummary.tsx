import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { normalizeMoney } from "../../../lib/workflow-api";

export interface FloatingInterestPolicyView {
    periodUnit: "day" | "week";
    periodLength: 1;
    rateMode: "per_thousand" | "percent";
    rate: string;
    advanceInterestPeriods: 0 | 1;
    advanceInterestRefundPolicy: "non_refundable";
}

interface FloatingInterestSummaryProps {
    policy: FloatingInterestPolicyView;
    fullPeriodInterest?: string | null;
    advanceInterest?: string | null;
    netBorrowerPayout?: string | null;
    firstPeriodStartDate?: string | null;
    firstPeriodDueDate?: string | null;
    periodDays?: number | null;
    postedGrossAmount?: string | null;
    postedEventCount?: number | null;
    dueInterest?: string | null;
    accruedNotDueInterest?: string | null;
    children?: ReactNode;
}

export function FloatingInterestSummary({
    policy,
    fullPeriodInterest,
    advanceInterest,
    netBorrowerPayout,
    firstPeriodStartDate,
    firstPeriodDueDate,
    periodDays,
    postedGrossAmount,
    postedEventCount,
    dueInterest,
    accruedNotDueInterest,
    children,
}: FloatingInterestSummaryProps) {
    const { t, i18n } = useTranslation();
    const money = (value: string) => formatMoneyExact(value, i18n.language);
    const rate = policy.rateMode === "percent"
        ? t("loanDetail.floatingSummary.percentRate", { rate: policy.rate, period: t(`loanDetail.floatingSummary.period.${policy.periodUnit}`) })
        : t("loanDetail.floatingSummary.perThousandRate", { rate: policy.rate, period: t(`loanDetail.floatingSummary.period.${policy.periodUnit}`) });
    const payoutMismatch = Boolean(
        postedEventCount
        && postedGrossAmount !== null
        && postedGrossAmount !== undefined
        && netBorrowerPayout !== null
        && netBorrowerPayout !== undefined
        && normalizeMoney(postedGrossAmount) !== normalizeMoney(netBorrowerPayout),
    );

    return (
        <section role="region" aria-label={t("loanDetail.floatingSummary.title")}>
            <Card>
                <CardHeader>
                    <CardTitle>{t("loanDetail.floatingSummary.title")}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                            <dt className="text-muted-foreground">{t("loanDetail.floatingSummary.periodLabel")}</dt>
                            <dd className="font-medium">{t(`loanDetail.floatingSummary.periodName.${policy.periodUnit}`)}</dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground">{t("loanDetail.floatingSummary.contractRate")}</dt>
                            <dd className="font-medium tabular-nums">{rate}</dd>
                        </div>
                        {(dueInterest !== null && dueInterest !== undefined) && <div>
                            <dt className="text-muted-foreground">{t("loanDetail.floatingSummary.dueInterest")}</dt>
                            <dd className="font-medium tabular-nums">{money(dueInterest)}</dd>
                        </div>}
                        {(dueInterest !== null && dueInterest !== undefined) && <div>
                            <dt className="text-muted-foreground">{t("loanDetail.floatingSummary.accruingInterest")}</dt>
                            <dd className="font-medium tabular-nums">{accruedNotDueInterest === null || accruedNotDueInterest === undefined ? t("loanDetail.floatingSummary.previewRequired") : money(accruedNotDueInterest)}</dd>
                        </div>}
                    </dl>

                    {(fullPeriodInterest !== null && fullPeriodInterest !== undefined) && (
                        <dl className="grid gap-3 rounded border bg-muted/30 p-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                            <div><dt className="text-muted-foreground">{t("loanDetail.floatingSummary.fullPeriodInterest")}</dt><dd className="font-medium tabular-nums">{money(fullPeriodInterest)}</dd></div>
                            <div><dt className="text-muted-foreground">{t("loanDetail.floatingSummary.advanceInterest")}</dt><dd className="font-medium tabular-nums">{money(advanceInterest ?? "0.00")}</dd></div>
                            <div><dt className="text-muted-foreground">{t("loanDetail.floatingSummary.netPayout")}</dt><dd className="font-medium tabular-nums">{money(netBorrowerPayout ?? "0.00")}</dd></div>
                            <div><dt className="text-muted-foreground">{t("loanDetail.floatingSummary.periodDays")}</dt><dd className="font-medium">{periodDays ?? "—"}</dd></div>
                            <div><dt className="text-muted-foreground">{t("loanDetail.floatingSummary.periodStart")}</dt><dd className="font-medium">{firstPeriodStartDate ?? "—"}</dd></div>
                            <div><dt className="text-muted-foreground">{t("loanDetail.floatingSummary.periodDue")}</dt><dd className="font-medium">{firstPeriodDueDate ?? "—"}</dd></div>
                        </dl>
                    )}

                    {policy.advanceInterestPeriods === 1 && policy.advanceInterestRefundPolicy === "non_refundable" && (
                        <div className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{t("loanDetail.floatingSummary.nonRefundableWarning")}</span>
                        </div>
                    )}

                    {payoutMismatch && (
                        <div role="status" className="flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{t("loanDetail.floatingSummary.payoutMismatch", { actual: money(postedGrossAmount!), contract: money(netBorrowerPayout!) })}</span>
                        </div>
                    )}

                    {children}
                </CardContent>
            </Card>
        </section>
    );
}
