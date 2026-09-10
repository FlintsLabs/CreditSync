import Decimal from "decimal.js";
import { useTranslation } from "react-i18next";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { formatMoneyExact } from "../../../lib/workflow-model";

export interface LoanAccrualRow {
    publicId: string;
    accrualDate: string;
    periodStartDate: string | null;
    periodEndDate: string | null;
    periodUnit: string | null;
    periodDayIndex: number | null;
    interestAmount: string;
    paidAmount: string;
    remainingAmount: string;
    status: string;
}

function formatDate(value: string | null, locale: string) {
    if (!value) return "—";
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(`${value}T00:00:00+07:00`));
}

export function LoanAccrualsTab({ rows }: { rows: LoanAccrualRow[] }) {
    const { t, i18n } = useTranslation();
    const activeRows = rows.filter((row) => row.status !== "reversed");
    const total = activeRows.reduce((sum, row) => sum.plus(row.interestAmount), new Decimal(0)).toFixed(2);
    const paid = activeRows.reduce((sum, row) => sum.plus(row.paidAmount), new Decimal(0)).toFixed(2);
    const remaining = activeRows.reduce((sum, row) => sum.plus(row.remainingAmount), new Decimal(0)).toFixed(2);
    const statusLabel = (status: string) => t(`loanDetail.accrualTable.statuses.${status}`, status);

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("loanDetail.accrualTable.title", "Accrual table")}</CardTitle>
                <CardDescription>{t("loanDetail.accrualTable.description", "Interest accrued for this agreement, including paid and remaining amounts.")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="grid gap-3 sm:grid-cols-3">
                    {[
                        ["total", total],
                        ["paid", paid],
                        ["remaining", remaining],
                    ].map(([key, amount]) => (
                        <div key={key} className="rounded-lg border bg-muted/20 p-3">
                            <div className="text-xs text-muted-foreground">{t(`loanDetail.accrualTable.summary.${key}`, key)}</div>
                            <div className="mt-1 font-semibold tabular-nums">{formatMoneyExact(amount, i18n.language)}</div>
                        </div>
                    ))}
                </div>
                {rows.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
                        {t("loanDetail.accrualTable.empty", "No accruals have been materialized.")}
                    </div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t("loanDetail.accrualTable.accrualDate", "Accrual date")}</TableHead>
                                <TableHead>{t("loanDetail.accrualTable.period", "Period")}</TableHead>
                                <TableHead className="text-right">{t("loanDetail.accrualTable.interest", "Interest")}</TableHead>
                                <TableHead className="text-right">{t("loanDetail.accrualTable.paid", "Paid")}</TableHead>
                                <TableHead className="text-right">{t("loanDetail.accrualTable.remaining", "Remaining")}</TableHead>
                                <TableHead>{t("loanDetail.accrualTable.status", "Status")}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {rows.map((row) => (
                                <TableRow key={row.publicId}>
                                    <TableCell className="whitespace-nowrap">{formatDate(row.accrualDate, i18n.language)}</TableCell>
                                    <TableCell className="whitespace-nowrap">{row.periodStartDate ? `${formatDate(row.periodStartDate, i18n.language)} – ${formatDate(row.periodEndDate, i18n.language)}` : "—"}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatMoneyExact(row.interestAmount, i18n.language)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatMoneyExact(row.paidAmount, i18n.language)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatMoneyExact(row.remainingAmount, i18n.language)}</TableCell>
                                    <TableCell><Badge variant={row.status === "reversed" ? "destructive" : row.status === "paid" ? "default" : "secondary"}>{statusLabel(row.status)}</Badge></TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
        </Card>
    );
}
