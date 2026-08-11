import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";

type RateType = "percent" | "per_thousand";
type RatePeriod = { publicId: string; effectiveDate: string; expiryDate: string | null; rateType: RateType; rate: string };
type Timeline = {
    loanPublicId: string;
    asOfDate: string;
    currentPeriod: RatePeriod | null;
    dailyInterestAtCurrentPrincipal: string | null;
    nextChange: RatePeriod | null;
    earliestEditableDate: string;
    timeline: RatePeriod[];
};
type Preview = {
    publicId: string;
    previewHash: string;
    expiresAt: string;
    request: Omit<RatePeriod, "publicId">;
    beforeTimeline: RatePeriod[];
    afterTimeline: RatePeriod[];
};

function rateLabel(period: Pick<RatePeriod, "rate" | "rateType">, percent: string, perThousand: string) {
    return `${period.rate} ${period.rateType === "percent" ? percent : perThousand}`;
}

export function FloatingInterestRateCard({ loanPublicId }: { loanPublicId: string }) {
    const { t, i18n } = useTranslation();
    const [timeline, setTimeline] = useState<Timeline | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [effectiveDate, setEffectiveDate] = useState("");
    const [expiryDate, setExpiryDate] = useState("");
    const [rateType, setRateType] = useState<RateType>("per_thousand");
    const [rate, setRate] = useState("");
    const [preview, setPreview] = useState<Preview | null>(null);
    const [reason, setReason] = useState("");
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        let active = true;
        void api.get(`/loans/${loanPublicId}/interest-rates`).then((response) => {
            if (!active) return;
            setTimeline(response.data);
            setEffectiveDate((current) => current || response.data.earliestEditableDate);
            setError("");
        }).catch(() => {
            if (active) setError(t("loanDetail.floatingRates.errors.load"));
        }).finally(() => {
            if (active) setLoading(false);
        });
        return () => { active = false; };
    }, [loanPublicId, t]);

    const requestPreview = async () => {
        try {
            setSubmitting(true);
            const response = await api.post(`/loans/${loanPublicId}/interest-rates/preview`, {
                effectiveDate, expiryDate: expiryDate || null, rateType, rate,
            });
            setPreview(response.data);
            setReason("");
            setError("");
        } catch {
            setError(t("loanDetail.floatingRates.errors.preview"));
        } finally {
            setSubmitting(false);
        }
    };

    const execute = async () => {
        if (!preview || !reason.trim()) return;
        try {
            setSubmitting(true);
            const response = await api.post(`/loans/${loanPublicId}/interest-rates/execute`, {
                previewPublicId: preview.publicId, previewHash: preview.previewHash, reason: reason.trim(),
            }, { headers: { "Idempotency-Key": crypto.randomUUID() } });
            setTimeline(response.data);
            setPreview(null);
            setRate("");
            setExpiryDate("");
            setError("");
        } catch {
            setError(t("loanDetail.floatingRates.errors.execute"));
        } finally {
            setSubmitting(false);
        }
    };

    const percent = t("loanDetail.floatingRates.percent");
    const perThousand = t("loanDetail.floatingRates.perThousand");
    return (
        <Card data-testid="floating-interest-rate-card">
            <CardHeader><CardTitle>{t("loanDetail.floatingRates.title")}</CardTitle></CardHeader>
            <CardContent className="space-y-5">
                {loading ? <div className="text-sm text-muted-foreground">{t("common.loading")}</div> : timeline && (
                    <>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <div className="rounded border p-3"><div className="text-xs text-muted-foreground">{t("loanDetail.floatingRates.currentRate")}</div><div className="mt-1 font-semibold tabular-nums">{timeline.currentPeriod ? rateLabel(timeline.currentPeriod, percent, perThousand) : "-"}</div></div>
                            <div className="rounded border p-3"><div className="text-xs text-muted-foreground">{t("loanDetail.floatingRates.dailyInterest")}</div><div className="mt-1 font-semibold tabular-nums">{timeline.dailyInterestAtCurrentPrincipal ? formatMoneyExact(timeline.dailyInterestAtCurrentPrincipal, i18n.language) : "-"}</div></div>
                            <div className="rounded border p-3"><div className="text-xs text-muted-foreground">{t("loanDetail.floatingRates.nextChange")}</div><div className="mt-1 font-semibold tabular-nums">{timeline.nextChange ? `${timeline.nextChange.effectiveDate} · ${rateLabel(timeline.nextChange, percent, perThousand)}` : t("loanDetail.floatingRates.none")}</div></div>
                        </div>
                        <div className="space-y-2">
                            {timeline.timeline.map((period) => <div key={period.publicId} className="flex flex-wrap justify-between gap-2 rounded bg-muted p-3 text-sm"><span>{period.effectiveDate} — {period.expiryDate ?? t("loanDetail.floatingRates.openEnded")}</span><span className="font-medium tabular-nums">{rateLabel(period, percent, perThousand)}</span></div>)}
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                            <label className="space-y-1 text-sm"><span>{t("loanDetail.floatingRates.effectiveDate")}</span><Input type="date" min={timeline.earliestEditableDate} value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} /></label>
                            <label className="space-y-1 text-sm"><span>{t("loanDetail.floatingRates.expiryDate")}</span><Input type="date" min={effectiveDate || timeline.earliestEditableDate} value={expiryDate} onChange={(event) => setExpiryDate(event.target.value)} /></label>
                            <label className="space-y-1 text-sm"><span>{t("loanDetail.floatingRates.rateType")}</span><select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={rateType} onChange={(event) => setRateType(event.target.value as RateType)}><option value="per_thousand">{perThousand}</option><option value="percent">{percent}</option></select></label>
                            <label className="space-y-1 text-sm"><span>{t("loanDetail.floatingRates.rate")}</span><Input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} placeholder="15.0000" /></label>
                        </div>
                        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground"><span>{t("loanDetail.floatingRates.earliestEditable", { date: timeline.earliestEditableDate })}</span><Button disabled={submitting || !effectiveDate || !rate.trim()} onClick={() => void requestPreview()}>{t("loanDetail.floatingRates.preview")}</Button></div>
                    </>
                )}
                {error && <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
            </CardContent>
            <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && !submitting && setPreview(null)}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader><DialogTitle>{t("loanDetail.floatingRates.confirmTitle")}</DialogTitle><DialogDescription>{t("loanDetail.floatingRates.confirmDescription")}</DialogDescription></DialogHeader>
                    {preview && <div className="max-h-80 space-y-2 overflow-y-auto text-sm">{preview.afterTimeline.map((period) => <div key={period.publicId} className="flex flex-wrap justify-between gap-2 rounded border p-3"><span>{period.effectiveDate} — {period.expiryDate ?? t("loanDetail.floatingRates.openEnded")}</span><span className="font-medium tabular-nums">{rateLabel(period, percent, perThousand)}</span></div>)}<div className="text-xs text-muted-foreground">{t("loanDetail.floatingRates.expiresAt", { value: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(preview.expiresAt)) })}</div></div>}
                    <label className="space-y-1 text-sm"><span>{t("loanDetail.floatingRates.reason")}</span><Input value={reason} onChange={(event) => setReason(event.target.value)} /></label>
                    <DialogFooter><Button variant="outline" disabled={submitting} onClick={() => setPreview(null)}>{t("common.cancel")}</Button><Button disabled={submitting || !reason.trim()} onClick={() => void execute()}>{submitting ? t("loanDetail.floatingRates.executing") : t("loanDetail.floatingRates.confirm")}</Button></DialogFooter>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
