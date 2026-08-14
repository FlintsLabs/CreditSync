import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { api } from "../../../lib/api";

export interface OpeningBalanceComponent { publicId: string; kind: string; amount: string; status: string; sourceType: string; sourcePublicId: string }
export interface RestructureWaiver { publicId: string; component: string; amount: string; reason: string; status: string }
export interface RestructureLineage { restructuredFromPublicId?: string | null; restructuredToPublicId?: string | null; inbound?: { status: string } | null; outbound?: { status: string } | null }

interface DisbursementEvent { publicId: string; status: "draft" | "posted" | "reversed"; loanAttributedAmount: string; note?: string | null; reversedEventPublicId?: string | null }

export function LoanOpeningBalances({ loanPublicId, lineage, components = [], waivers = [] }: { loanPublicId?: string; lineage?: RestructureLineage | null; components?: OpeningBalanceComponent[]; waivers?: RestructureWaiver[] }) {
    const { t, i18n } = useTranslation();
    const [payouts, setPayouts] = useState<DisbursementEvent[]>([]);
    const additionalSources = components.filter(item => item.kind === "additional_principal").map(item => item.sourcePublicId);
    const additionalSourceKey = additionalSources.join("|");
    useEffect(() => {
        if (!loanPublicId || !additionalSourceKey) return;
        let active = true;
        void api.get(`/loans/${loanPublicId}/disbursements`).then(response => {
            const events = (response.data as { events?: DisbursementEvent[] }).events ?? [];
            const direct = events.filter(event => additionalSources.some(source => event.note?.includes(source)));
            const directIds = new Set(direct.map(event => event.publicId));
            const related = events.filter(event => directIds.has(event.publicId) || Boolean(event.reversedEventPublicId && directIds.has(event.reversedEventPublicId)));
            if (active) setPayouts(related);
        }).catch(() => { if (active) setPayouts([]); });
        return () => { active = false; };
    // additionalSourceKey is the stable semantic dependency for the source list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loanPublicId, additionalSourceKey]);
    if (!lineage && components.length === 0 && waivers.length === 0) return null;
    const activeComponents = components.filter(item => item.status === "executed");
    const reversedComponents = components.filter(item => item.status === "reversed");
    const hasAdditional = components.some(item => item.kind === "additional_principal");
    const relatedPayouts = loanPublicId && additionalSourceKey ? payouts : [];
    return <Card>
        <CardHeader><CardTitle>{t("loanDetail.restructureBalances.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
            {lineage && <nav aria-label={t("loanDetail.restructureBalances.lineage")} className="flex flex-wrap gap-3 text-sm">
                {lineage.restructuredFromPublicId && <Link className="text-primary hover:underline" to={`/loans/${lineage.restructuredFromPublicId}`}>{t("loanDetail.restructureBalances.from")} <span className="font-mono">{lineage.restructuredFromPublicId}</span></Link>}
                {lineage.restructuredToPublicId && <Link className="text-primary hover:underline" to={`/loans/${lineage.restructuredToPublicId}`}>{t("loanDetail.restructureBalances.to")} <span className="font-mono">{lineage.restructuredToPublicId}</span></Link>}
            </nav>}
            {activeComponents.length > 0 && <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">{activeComponents.map(item => <div key={item.publicId} className="rounded border p-3"><dt className="text-muted-foreground">{t(`loanDetail.restructureBalances.kinds.${item.kind}`, { defaultValue: item.kind })}</dt><dd className="mt-1 font-medium tabular-nums">{formatMoneyExact(item.amount, i18n.language)}</dd></div>)}</dl>}
            {reversedComponents.length > 0 && <div><h4 className="text-sm font-semibold">{t("loanDetail.restructureBalances.reversedHistory")}</h4><dl className="mt-2 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">{reversedComponents.map(item => <div key={item.publicId} className="rounded border p-3 text-muted-foreground"><dt>{t(`loanDetail.restructureBalances.kinds.${item.kind}`, { defaultValue: item.kind })}</dt><dd className="mt-1 tabular-nums line-through">{formatMoneyExact(item.amount, i18n.language)}</dd></div>)}</dl></div>}
            {waivers.length > 0 && <div><h4 className="text-sm font-semibold">{t("loanDetail.restructureBalances.waivers")}</h4><div className="mt-2 space-y-2">{waivers.filter(item => item.status === "executed").map(item => <div key={item.publicId} className="rounded border p-3 text-sm"><span className="font-medium">{t(`loanDetail.restructureBalances.waiverComponents.${item.component}`, { defaultValue: item.component })} · {formatMoneyExact(item.amount, i18n.language)}</span><p className="text-muted-foreground">{item.reason}</p></div>)}</div></div>}
            {hasAdditional && <div className="rounded bg-muted/40 p-3 text-sm"><div className="font-medium">{t("loanDetail.restructureBalances.payoutStatus")}</div>{relatedPayouts.length > 0 ? <ul className="mt-2 space-y-1">{relatedPayouts.map(event => <li key={event.publicId}><Link className="text-primary hover:underline" to={`/loans/${loanPublicId}#disbursement-${event.publicId}`}>{t(`loanDetail.disbursements.recordStatus.${event.status}`)} · {formatMoneyExact(event.loanAttributedAmount, i18n.language)}</Link></li>)}</ul> : <span className="text-muted-foreground">{t("loanDetail.restructureBalances.noRelatedPayout")}</span>}</div>}
        </CardContent>
    </Card>;
}
