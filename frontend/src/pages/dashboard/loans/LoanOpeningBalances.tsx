import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { formatMoneyExact } from "../../../lib/workflow-model";

export interface OpeningBalanceComponent { publicId: string; kind: string; amount: string; status: string; sourceType: string; sourcePublicId: string }
export interface RestructureWaiver { publicId: string; component: string; amount: string; reason: string; status: string }
export interface RestructureLineage { restructuredFromPublicId?: string | null; restructuredToPublicId?: string | null; inbound?: { status: string } | null; outbound?: { status: string } | null }

export function LoanOpeningBalances({ lineage, components = [], waivers = [] }: { lineage?: RestructureLineage | null; components?: OpeningBalanceComponent[]; waivers?: RestructureWaiver[] }) {
    const { t, i18n } = useTranslation();
    if (!lineage && components.length === 0 && waivers.length === 0) return null;
    const additional = components.find(item => item.kind === "additional_principal");
    return <Card>
        <CardHeader><CardTitle>{t("loanDetail.restructureBalances.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
            {lineage && <nav aria-label={t("loanDetail.restructureBalances.lineage")} className="flex flex-wrap gap-3 text-sm">
                {lineage.restructuredFromPublicId && <Link className="text-primary hover:underline" to={`/loans/${lineage.restructuredFromPublicId}`}>{t("loanDetail.restructureBalances.from")} <span className="font-mono">{lineage.restructuredFromPublicId}</span></Link>}
                {lineage.restructuredToPublicId && <Link className="text-primary hover:underline" to={`/loans/${lineage.restructuredToPublicId}`}>{t("loanDetail.restructureBalances.to")} <span className="font-mono">{lineage.restructuredToPublicId}</span></Link>}
            </nav>}
            {components.length > 0 && <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">{components.filter(item => item.status === "executed").map(item => <div key={item.publicId} className="rounded border p-3"><dt className="text-muted-foreground">{t(`loanDetail.restructureBalances.kinds.${item.kind}`, { defaultValue: item.kind })}</dt><dd className="mt-1 font-medium tabular-nums">{formatMoneyExact(item.amount, i18n.language)}</dd></div>)}</dl>}
            {waivers.length > 0 && <div><h4 className="text-sm font-semibold">{t("loanDetail.restructureBalances.waivers")}</h4><div className="mt-2 space-y-2">{waivers.filter(item => item.status === "executed").map(item => <div key={item.publicId} className="rounded border p-3 text-sm"><span className="font-medium">{t(`loanDetail.restructureBalances.waiverComponents.${item.component}`, { defaultValue: item.component })} · {formatMoneyExact(item.amount, i18n.language)}</span><p className="text-muted-foreground">{item.reason}</p></div>)}</div></div>}
            {additional && <div className="rounded bg-muted/40 p-3 text-sm"><span className="font-medium">{t("loanDetail.restructureBalances.payoutStatus")}</span><span className="text-muted-foreground"> · {t("loanDetail.restructureBalances.payoutSeparate")}</span></div>}
        </CardContent>
    </Card>;
}
