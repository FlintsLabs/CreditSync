import { useCallback, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, CheckCircle2, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../../../lib/api";
import { getStoredUser, isTenantAdminUser } from "../../../lib/session";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { invalidateLoanQueries } from "../../../lib/loan-query-invalidation";

type ReplacementWarning =
    | { code: "OUTSTANDING_INTEREST_CORRECTED_TO_ZERO"; details: { amount: string; correctedAmount: "0.00"; collected: false; carriedForward: false } }
    | { code: "OUTSTANDING_PENALTY_CORRECTED_TO_ZERO"; details: { amount: string; correctedAmount: "0.00"; treatedAsBorrowerPayment: false } };

interface ReplacementPreview {
    publicId: string;
    previewHash: string;
    oldBalanceVersion: string;
    replacementDraftVersion: string;
    expiresAt: string;
    asOfDate: string;
    reason: string;
    oldLoan: { loanPublicId: string; principal: string; collectibleBefore: { principal: string; interest: string; fee: string; penalty: string; nextDueDate: string | null }; collectibleAfter: { principal: string; interest: string; fee: string; penalty: string; nextDueDate: null } };
    cash: { direction: "none"; amount: string };
    correction: { principal: string; interest: string; fee: string; penalty: string };
    replacement: { loanPublicId: string; principal: string; interestRate: string; repaymentType: string; termMonths: number; totalInstallments: number; installmentAmount: string; startDate: string; firstDueDate: string; lastDueDate: string; totalRepayment: string; fundingSourceKind: "drawdown" | "own_capital"; fundingSourcePublicId: string; fundingSourceName: string };
    warnings: ReplacementWarning[];
}

interface ReplacementResult {
    replacementPublicId: string;
    oldLoanPublicId: string;
    replacementLoanPublicId: string;
    status: "executed" | "reversed";
}

function replacementLocale(language: string) {
    return language.toLowerCase().startsWith("th")
        ? "th-TH-u-ca-gregory-nu-latn"
        : "en-GB";
}

function dateValue(value: string, language: string) {
    return new Intl.DateTimeFormat(replacementLocale(language), {
        timeZone: "Asia/Bangkok",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
    }).format(new Date(`${value}T00:00:00+07:00`));
}

function dateTimeValue(value: string, language: string) {
    const parts = new Intl.DateTimeFormat(replacementLocale(language), {
        timeZone: "Asia/Bangkok",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).formatToParts(new Date(value));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
    return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

function domainFailure(caught: unknown) {
    const data = (caught as { response?: { data?: { code?: unknown; details?: { reviewRequired?: unknown; blockerPublicIds?: unknown } } } }).response?.data;
    return {
        code: typeof data?.code === "string" ? data.code : null,
        reviewRequired: data?.details?.reviewRequired === true,
        blockerPublicIds: Array.isArray(data?.details?.blockerPublicIds)
            ? data.details.blockerPublicIds.filter((value): value is string => typeof value === "string")
            : [],
    };
}

/** Owner/manager replacement command surface. All financial values are supplied by the preview response. */
export function LoanReplacementPanel({ oldLoanPublicId, lineage }: { oldLoanPublicId: string; lineage?: { replacementPublicId: string; status: "executed" | "reversed"; replacedFromPublicId: string | null; replacedToPublicId: string | null } | null }) {
    const { t, i18n } = useTranslation();
    const [draftLoanPublicId, setDraftLoanPublicId] = useState("");
    const [reason, setReason] = useState("");
    const [preview, setPreview] = useState<ReplacementPreview | null>(null);
    const [result, setResult] = useState<ReplacementResult | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [reverseReason, setReverseReason] = useState("");
    const [reverseConfirmed, setReverseConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ message: string; blockerPublicIds: string[] } | null>(null);
    const executeKey = useRef<string | null>(null);
    const reverseKey = useRef<string | null>(null);
    const money = useCallback((value: string) => formatMoneyExact(value, i18n.language), [i18n.language]);
    const warningText = useCallback((warning: ReplacementWarning) => t(`replacement.warnings.${warning.code}`, {
        amount: money(warning.details.amount),
        correctedAmount: money(warning.details.correctedAmount),
        defaultValue: t("replacement.warnings.generic"),
    }), [money, t]);

    if (!isTenantAdminUser(getStoredUser())) return null;

    const clearPreview = () => { setPreview(null); setResult(null); setConfirmed(false); executeKey.current = null; };
    const previewReplacement = async () => {
        setBusy(true); setError(null); clearPreview();
        try {
            const response = await api.post("/loans/replacements/preview", { oldLoanPublicId, replacementDraftPublicId: draftLoanPublicId.trim(), reason: reason.trim() });
            setPreview(response.data as ReplacementPreview);
        } catch (caught) {
            const failure = domainFailure(caught);
            setError({
                message: failure.code ? t(`domainErrors.${failure.code}`, { defaultValue: t("replacement.errors.preview") }) : t("replacement.errors.preview"),
                blockerPublicIds: failure.blockerPublicIds,
            });
        } finally { setBusy(false); }
    };
    const execute = async () => {
        if (!preview || !confirmed) return;
        setBusy(true); setError(null);
        try {
            executeKey.current ??= crypto.randomUUID();
            const response = await api.post(`/loans/replacements/${preview.publicId}/execute`, {
                confirmed: true, previewHash: preview.previewHash, expectedOldBalanceVersion: preview.oldBalanceVersion,
                expectedReplacementDraftVersion: preview.replacementDraftVersion, reason: preview.reason,
            }, { headers: { "Idempotency-Key": executeKey.current } });
            const next = response.data as ReplacementResult;
            setResult(next); invalidateLoanQueries([next.oldLoanPublicId, next.replacementLoanPublicId]);
        } catch (caught) {
            const failure = domainFailure(caught);
            setError({
                message: failure.code ? t(`domainErrors.${failure.code}`, { defaultValue: t("replacement.errors.execute") }) : t("replacement.errors.execute"),
                blockerPublicIds: failure.blockerPublicIds,
            });
            if (failure.reviewRequired || failure.code === "REPLACEMENT_PREVIEW_STALE" || failure.code === "REPLACEMENT_PREVIEW_EXPIRED") clearPreview();
        } finally { setBusy(false); }
    };
    const reverse = async () => {
        const current = result ?? (lineage?.status === "executed" ? { replacementPublicId: lineage.replacementPublicId, oldLoanPublicId: lineage.replacedFromPublicId ?? oldLoanPublicId, replacementLoanPublicId: lineage.replacedToPublicId ?? oldLoanPublicId, status: "executed" as const } : null);
        if (!current || !reverseConfirmed || !reverseReason.trim()) return;
        setBusy(true); setError(null);
        try {
            reverseKey.current ??= crypto.randomUUID();
            const response = await api.post(`/loans/replacements/${current.replacementPublicId}/reverse`, { confirmed: true, reason: reverseReason.trim() }, { headers: { "Idempotency-Key": reverseKey.current } });
            const next = response.data as ReplacementResult;
            setResult(next); invalidateLoanQueries([next.oldLoanPublicId, next.replacementLoanPublicId]);
        } catch (caught) {
            const failure = domainFailure(caught);
            setError({
                message: failure.code ? t(`domainErrors.${failure.code}`, { defaultValue: t("replacement.errors.reverse") }) : t("replacement.errors.reverse"),
                blockerPublicIds: failure.blockerPublicIds,
            });
            if (failure.reviewRequired) {
                setConfirmed(false);
                executeKey.current = null;
                setReverseConfirmed(false);
                reverseKey.current = null;
            }
        } finally { setBusy(false); }
    };

    return <Card aria-busy={busy}>
        <CardHeader><CardTitle className="flex items-center gap-2"><ArrowRightLeft className="h-5 w-5" />{t("replacement.title")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{t("replacement.description")}</p>
            {error && <div role="alert" className="flex gap-2 rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" /><div><div>{error.message}</div>{error.blockerPublicIds.length > 0 && <div className="mt-2"><div className="font-medium">{t("replacement.blockers")}</div><ul className="list-disc pl-5">{error.blockerPublicIds.map((id) => <li key={id}><code>{id}</code></li>)}</ul></div>}</div></div>}
            {!preview && !result && (!lineage || lineage.status === "reversed") && <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-1 text-sm" htmlFor="replacement-draft">{t("replacement.draftLoan")}<Input id="replacement-draft" value={draftLoanPublicId} onChange={(event) => { setDraftLoanPublicId(event.target.value); clearPreview(); }} /></label>
                <label className="grid gap-1 text-sm" htmlFor="replacement-reason">{t("replacement.reason")}<Input id="replacement-reason" value={reason} onChange={(event) => { setReason(event.target.value); clearPreview(); }} /></label>
                <Button className="sm:col-span-2 w-fit" disabled={busy || !draftLoanPublicId.trim() || !reason.trim()} onClick={() => void previewReplacement()}>{t("replacement.preview")}</Button>
            </div>}
            {preview && !result && <section className="space-y-4 rounded border p-4" aria-label={t("replacement.previewTitle")}>
                <h3 className="font-semibold">{t("replacement.previewTitle")}</h3>
                <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    {([
                        ["oldPrincipal", preview.oldLoan.collectibleBefore.principal], ["oldInterest", preview.oldLoan.collectibleBefore.interest], ["oldFee", preview.oldLoan.collectibleBefore.fee], ["oldPenalty", preview.oldLoan.collectibleBefore.penalty],
                        ["afterPrincipal", preview.oldLoan.collectibleAfter.principal], ["afterInterest", preview.oldLoan.collectibleAfter.interest], ["afterFee", preview.oldLoan.collectibleAfter.fee], ["afterPenalty", preview.oldLoan.collectibleAfter.penalty],
                        ["correctedPrincipal", preview.correction.principal], ["correctedInterest", preview.correction.interest], ["correctedFee", preview.correction.fee], ["correctedPenalty", preview.correction.penalty],
                        ["noCash", preview.cash.amount], ["replacementPrincipal", preview.replacement.principal], ["installment", preview.replacement.installmentAmount], ["totalRepayment", preview.replacement.totalRepayment],
                    ] as const).map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{t(`replacement.${label}`)}</dt><dd className="font-medium tabular-nums">{money(value)}</dd></div>)}
                    <div><dt className="text-muted-foreground">{t("replacement.startDate")}</dt><dd className="font-medium">{dateValue(preview.replacement.startDate, i18n.language)}</dd></div>
                    <div><dt className="text-muted-foreground">{t("replacement.firstDueDate")}</dt><dd className="font-medium">{dateValue(preview.replacement.firstDueDate, i18n.language)}</dd></div>
                    <div><dt className="text-muted-foreground">{t("replacement.lastDueDate")}</dt><dd className="font-medium">{dateValue(preview.replacement.lastDueDate, i18n.language)}</dd></div>
                    <div><dt className="text-muted-foreground">{t("replacement.terms")}</dt><dd className="font-medium">{t(`loanWizard.repaymentOptions.${preview.replacement.repaymentType}`)} · {preview.replacement.termMonths} · {preview.replacement.totalInstallments}</dd></div>
                    <div><dt className="text-muted-foreground">{t("replacement.funding")}</dt><dd className="font-medium">{t(`replacement.fundingKinds.${preview.replacement.fundingSourceKind}`)} · {preview.replacement.fundingSourceName}</dd></div>
                </dl>
                <div className="text-sm"><span className="text-muted-foreground">{t("replacement.reason")}: </span>{preview.reason}</div><div className="text-sm"><span className="text-muted-foreground">{t("replacement.asOfDate")}: </span>{dateValue(preview.asOfDate, i18n.language)}</div>
                <div className="text-xs text-muted-foreground">{t("replacement.expires", { value: dateTimeValue(preview.expiresAt, i18n.language) })}</div>
                {preview.warnings.length > 0 && <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800 dark:text-amber-200">{preview.warnings.map((warning) => <li key={`${warning.code}:${warning.details.amount}`}>{warningText(warning)}</li>)}</ul>}
                <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>{t("replacement.confirmation")}</span></label>
                <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={clearPreview}>{t("replacement.edit")}</Button><Button disabled={busy || !confirmed} onClick={() => void execute()}><CheckCircle2 className="mr-2 h-4 w-4" />{t("replacement.execute")}</Button></div>
            </section>}
            {(result?.status === "executed" || lineage?.status === "executed") && <section className="space-y-3 rounded border border-emerald-500/30 bg-emerald-500/10 p-4"><div role="status" className="font-medium text-emerald-700 dark:text-emerald-300">{t("replacement.executed")}</div><label className="grid gap-1 text-sm" htmlFor="replacement-reverse-reason">{t("replacement.reversalReason")}<Input id="replacement-reverse-reason" value={reverseReason} onChange={(event) => { setReverseReason(event.target.value); setReverseConfirmed(false); reverseKey.current = null; }} /></label><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={reverseConfirmed} onChange={(event) => setReverseConfirmed(event.target.checked)} /><span>{t("replacement.reversalConfirmation")}</span></label><Button variant="destructive" disabled={busy || !reverseReason.trim() || !reverseConfirmed} onClick={() => void reverse()}><RotateCcw className="mr-2 h-4 w-4" />{t("replacement.reverse")}</Button></section>}
            {result?.status === "reversed" && <div role="status" className="rounded border p-3 text-sm">{t("replacement.reversed")}</div>}
        </CardContent>
    </Card>;
}
