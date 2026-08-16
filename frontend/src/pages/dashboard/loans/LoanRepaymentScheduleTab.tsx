import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";

interface ScheduleRow { id: string; publicId: string; installmentNo: number; dueDate: string; remainingDue: string; status: string; commissionGenerated?: string }

export function LoanRepaymentScheduleTab({ loanPublicId }: { loanPublicId: string }) {
    const { t, i18n } = useTranslation();
    const [rows, setRows] = useState<ScheduleRow[]>([]);
    const [totalCommission, setTotalCommission] = useState("0.00");
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let active = true;
        Promise.all([api.get(`/loans/${loanPublicId}/schedule`), api.get(`/loans/${loanPublicId}`)])
            .then(([scheduleResponse, loanResponse]) => {
                if (!active) return;
                setRows(scheduleResponse.data ?? []);
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
                <div className="overflow-x-auto"><Table className="min-w-[42rem]"><TableHeader><TableRow><TableHead>{t("loanDetail.scheduleColumns.installment")}</TableHead><TableHead>{t("loanDetail.scheduleColumns.dueDate")}</TableHead><TableHead className="text-right">{t("loanDetail.scheduleColumns.remainingDue")}</TableHead><TableHead className="text-right">{t("loanDetail.scheduleColumns.commission", "Commission generated")}</TableHead><TableHead className="text-right">{t("loanDetail.scheduleColumns.status")}</TableHead></TableRow></TableHeader><TableBody>{rows.slice(0, 8).map((row) => <TableRow key={row.publicId ?? row.id}><TableCell className="font-medium">{t("loanDetail.installmentLabel", { defaultValue: "Installment #{{id}}", id: row.installmentNo })}</TableCell><TableCell>{row.dueDate}</TableCell><TableCell className="text-right tabular-nums">{formatMoneyExact(row.remainingDue, i18n.language)}</TableCell><TableCell className="text-right tabular-nums">{row.commissionGenerated == null ? "—" : formatMoneyExact(row.commissionGenerated, i18n.language)}</TableCell><TableCell className="text-right"><Badge variant={row.status === "overdue" ? "destructive" : row.status === "paid" ? "secondary" : "outline"}>{t(`loans.paymentHealth.scheduleStatus.${row.status}`, { defaultValue: row.status })}</Badge></TableCell></TableRow>)}</TableBody></Table></div>
            </div>}
    </CardContent></Card>;
}
