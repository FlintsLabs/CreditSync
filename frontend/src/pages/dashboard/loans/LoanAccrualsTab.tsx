import { FinancialDecimal } from "../../../lib/financial-decimal";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Input } from "../../../components/ui/Input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog";
import { Badge } from "../../../components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../components/ui/table";
import { formatMoneyExact } from "../../../lib/workflow-model";
import { sumAccrualMoney } from "./loan-accrual-payment-model";
import { normalizeMoney } from "../../../lib/workflow-api";

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
    receiptHistory?: Array<{ amount: string; receivedAt: string | null; recordedAt: string | null; paymentIntakePublicId: string | null; transactionPublicId: string | null; status: string; sourceKind: string; href: string | null }>;
}

type Draft = { selected: Record<string, string>; receivedAt: string; notes?: string; bankReference?: string; paymentIntakePublicId?: string; preview?: { publicId: string; status: string; warnings?: Array<{ code?: string }>; totalAllocated?: string; receivedAt?: string; targets?: Array<{ accrualDate: string; amount: string }>; remainingDebt?: { principal: string; fees: string; interest: string; penalty: string } }; previewKey: string; postKey: string; postStatus?: "pending" | "posted"; posted?: boolean; receiptPublicId?: string; auditPublicId?: string; correlationId?: string };
const translatedDomainErrors: Record<string, string> = {
    INVALID_MONEY: "invalidAmount", INVALID_PAYMENT_AMOUNT: "invalidAmount", DUPLICATE_ACCRUAL_TARGET: "duplicateTarget",
    FLOATING_ACCRUAL_TARGET_UNAVAILABLE: "dateUnavailable", FLOATING_ACCRUAL_CAPACITY_EXCEEDED: "capacityExceeded",
    FLOATING_DAILY_PAYMENT_UNSUPPORTED: "dailyPolicyRequired", PAYMENT_INTAKE_IMMUTABLE: "intakeImmutable",
    PAYMENT_INTAKE_NOT_FOUND: "intakeUnavailable", PAYMENT_TARGET_NOT_FOUND: "targetUnavailable",
    POSSIBLE_DUPLICATE_REQUIRES_REVIEW: "duplicateReview", PAYMENT_DUPLICATE_REQUIRES_REVIEW: "duplicateReview",
    POSSIBLE_SEMANTIC_DUPLICATE: "duplicateReview", FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION: "historicalConflict",
    FLOATING_ALLOCATION_INTEGRITY_REPAIR_REQUIRED: "ledgerRepairRequired", FLOATING_INTEREST_ACCRUAL_MISSING: "ledgerRepairRequired",
    FLOATING_ADVANCE_INTEREST_ALLOCATION_MISMATCH: "ledgerRepairRequired", FLOATING_INTEREST_ALLOCATION_MISMATCH: "ledgerRepairRequired",
    FLOATING_PENALTY_ALLOCATION_MISMATCH: "ledgerRepairRequired", STALE_PAYMENT_PROPOSAL: "previewStale", PAYMENT_NOT_READY: "previewStale",
    PAYMENT_PROPOSAL_NOT_FOUND: "previewStale", PAYMENT_CONFIRMATION_REQUIRED: "confirmationRequired",
    PAYMENT_AUDIT_NOT_FOUND: "receiptRecovery", IDEMPOTENCY_KEY_REQUIRED: "retrySameDraft",
    IDEMPOTENCY_PAYLOAD_MISMATCH: "retrySameDraft", INVALID_RECEIVED_AT: "invalidDateTime",
    INVALID_ACCRUAL_DATE: "dateUnavailable", INVALID_ACCRUAL_TARGETS: "invalidAmount", INVALID_SELECTED_FLOATING_TARGET: "dateUnavailable",
    SELECTED_FLOATING_REVIEW_REQUIRED: "previewStale", INVALID_PAYMENT_TARGET: "targetUnavailable",
    FUTURE_RECEIPT_NOT_ALLOWED: "futureReceipt", ACCRUAL_AFTER_RECEIPT: "accrualAfterReceipt",
};
const translatedWarnings: Record<string, string> = {
    POSSIBLE_SEMANTIC_DUPLICATE: "duplicateReview", PAYMENT_DUPLICATE_REQUIRES_REVIEW: "duplicateReview",
    ALLOCATION_EXCEEDS_OBLIGATION: "allocationWarning", ALLOCATION_SUM_MISMATCH: "allocationWarning",
};
// These service errors are raised before posting starts, so an initial command
// can be safely edited. HTTP status alone never proves that a write did not commit.
const provenPreCommitRejections = new Set([
    "PAYMENT_CONFIRMATION_REQUIRED", "INVALID_RECEIVED_AT", "FUTURE_RECEIPT_NOT_ALLOWED",
    "ACCRUAL_AFTER_RECEIPT", "INVALID_ACCRUAL_DATE", "INVALID_ACCRUAL_TARGETS",
    "INVALID_SELECTED_FLOATING_TARGET", "DUPLICATE_ACCRUAL_TARGET", "INVALID_MONEY",
    "INVALID_PAYMENT_AMOUNT", "FLOATING_ACCRUAL_TARGET_UNAVAILABLE", "FLOATING_ACCRUAL_CAPACITY_EXCEEDED",
    "FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION", "POSSIBLE_DUPLICATE_REQUIRES_REVIEW",
    "PAYMENT_DUPLICATE_REQUIRES_REVIEW", "POSSIBLE_SEMANTIC_DUPLICATE",
]);
function domainErrorCode(cause: unknown): string | undefined {
    if (!cause || typeof cause !== "object") return undefined;
    const data = (cause as { response?: { data?: unknown } }).response?.data;
    if (!data || typeof data !== "object") return undefined;
    const code = (data as { code?: unknown }).code;
    return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,95}$/.test(code) ? code : undefined;
}
function domainErrorStatus(cause: unknown): number | undefined {
    const status = cause && typeof cause === "object" ? (cause as { response?: { status?: unknown } }).response?.status : undefined;
    return typeof status === "number" ? status : undefined;
}
function bangkokDateTimeValue() { return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 16); }
function newDraft(selected: Record<string, string>): Draft { return { selected, receivedAt: bangkokDateTimeValue(), previewKey: crypto.randomUUID(), postKey: crypto.randomUUID() }; }
function commandHeaders(key: string) { return { "Idempotency-Key": key, "X-Request-Id": `selected:${key}`, "X-Correlation-Id": `selected:${key}` }; }

function formatDate(value: string | null, locale: string) {
    if (!value) return "—";
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(`${value}T00:00:00+07:00`));
}

export function LoanAccrualsTab({ rows, loanPublicId, canPaySelectedAccrual = true, onRefresh }: { rows: LoanAccrualRow[]; loanPublicId?: string; canPaySelectedAccrual?: boolean; onRefresh?: () => Promise<void> | void }) {
    const { t, i18n } = useTranslation();
    const storageKey = loanPublicId ? `creditsync:selected-accrual:${loanPublicId}` : "";
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<Draft | null>(() => {
        if (!storageKey) return null;
        try { const saved = localStorage.getItem(storageKey); return saved ? JSON.parse(saved) as Draft : null; }
        catch { localStorage.removeItem(storageKey); return null; }
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [refreshFailed, setRefreshFailed] = useState(false);
    const draftRevision = useRef(0);
    const persistDraft = (next: Draft) => { if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next)); };
    useEffect(() => { if (storageKey && draft) localStorage.setItem(storageKey, JSON.stringify(draft)); }, [draft, storageKey]);
    const totalSelected = useMemo(() => {
        try { return sumAccrualMoney(Object.values(draft?.selected ?? {}).map((value) => value || "0")); }
        catch { return "0.00"; }
    }, [draft]);
    const zeroVariance = Boolean(draft?.preview && draft.preview.totalAllocated && sumAccrualMoney([draft.preview.totalAllocated]) === totalSelected);
    const canEdit = Boolean(loanPublicId && canPaySelectedAccrual);
    const hasUnresolvedPost = draft?.postStatus === "pending";
    const isPosted = Boolean(draft?.posted || draft?.postStatus === "posted");
    const openPay = (row: LoanAccrualRow) => {
        if (isPosted || hasUnresolvedPost) { setOpen(true); return; }
        const selected = draft && !draft.posted ? { ...draft.selected } : {};
        selected[row.accrualDate] ??= row.remainingAmount;
        if (draft && !draft.posted) {
            const changedSelection = JSON.stringify(Object.entries(draft.selected).sort()) !== JSON.stringify(Object.entries(selected).sort());
            setDraft(changedSelection ? { ...draft, selected, preview: undefined, previewKey: crypto.randomUUID(), postKey: crypto.randomUUID() } : draft);
        } else setDraft(newDraft(selected));
        setError(""); setOpen(true);
    };
    const change = (next: Draft) => { if (hasUnresolvedPost || isPosted) return; draftRevision.current += 1; setDraft({ ...next, preview: undefined, previewKey: crypto.randomUUID(), postKey: crypto.randomUUID() }); setError(""); };
    const preview = async () => {
        if (!draft || !loanPublicId || hasUnresolvedPost || isPosted) return;
        const revision = draftRevision.current;
        setBusy(true); setError("");
        try {
            const targets = Object.entries(draft.selected).filter(([, amount]) => amount).map(([accrualDate, amount]) => {
                let canonical: string;
                try { canonical = normalizeMoney(amount); } catch { throw new Error("INVALID_TARGET_AMOUNT"); }
                if (!new FinancialDecimal(canonical).gt(0)) throw new Error("INVALID_TARGET_AMOUNT");
                return { accrualDate, amount: canonical };
            });
            const canonicalTotal = sumAccrualMoney(targets.map((target) => target.amount));
            const response = await api.post(`/loans/${loanPublicId}/accrual-payments/preview`, {
                amount: canonicalTotal, receivedAt: new Date(`${draft.receivedAt}:00+07:00`).toISOString(), targets,
                notes: draft.notes?.trim() || null, bankReference: draft.bankReference?.trim() || null,
                ...(draft.paymentIntakePublicId ? { paymentIntakePublicId: draft.paymentIntakePublicId } : {}),
            }, { headers: commandHeaders(draft.previewKey) });
            if (revision === draftRevision.current) setDraft((current) => current ? { ...current, paymentIntakePublicId: response.data.paymentIntakePublicId, preview: response.data } : current);
        } catch (cause) {
            if (cause instanceof Error && cause.message === "INVALID_TARGET_AMOUNT") setError(t("loanDetail.accrualPayment.errors.invalidAmount", "Enter a positive amount with at most two decimal places."));
            else {
                const code = domainErrorCode(cause);
                const errorKey = code ? translatedDomainErrors[code] : undefined;
                setError(errorKey ? t(`loanDetail.accrualPayment.errors.${errorKey}`, "Unable to preview this payment. Review the dates and amount.") : t("loanDetail.accrualPayment.errors.previewFailed", "Unable to preview this payment. Review the dates and amount."));
            }
        }
        finally { setBusy(false); }
    };
    const post = async () => {
        if (!draft?.preview || draft.preview.status !== "ready" || !loanPublicId) return;
        const proposalPublicId = draft.preview.publicId;
        const wasPendingAtStart = draft.postStatus === "pending" || draft.postStatus === "posted" || draft.posted === true;
        const pending = draft.postStatus === "pending" ? draft : { ...draft, postStatus: "pending" as const };
        persistDraft(pending);
        setDraft(pending);
        setBusy(true); setError("");
        try {
            const response = await api.post(`/loans/${loanPublicId}/accrual-payments/post`, { paymentIntakePublicId: pending.paymentIntakePublicId, proposalPublicId, confirmed: true }, { headers: commandHeaders(pending.postKey) });
            const posted = { ...pending, postStatus: "posted" as const, posted: true, receiptPublicId: response.data.receiptPublicId ?? response.data.publicId, auditPublicId: response.data.auditPublicId, correlationId: response.data.correlationId };
            persistDraft(posted); setDraft(posted); setRefreshFailed(false);
            try { await onRefresh?.(); localStorage.removeItem(storageKey); setDraft(null); setOpen(false); } catch { setRefreshFailed(true); }
        } catch (cause) {
            const status = domainErrorStatus(cause);
            const code = domainErrorCode(cause);
            // postPaymentKernel checks an already-posted intake replay before
            // validating proposal expiry. An authenticated stale-proposal result
            // therefore proves this attempt did not commit, even after an
            // uncertain retry; keep the intake and require a fresh preview.
            const expiredUnpostedProposal = status === 409 && code === "STALE_PAYMENT_PROPOSAL";
            const provenRejected = !wasPendingAtStart && status !== undefined && status >= 400 && status < 500 && code && provenPreCommitRejections.has(code);
            if (expiredUnpostedProposal || provenRejected) {
                const rejected = { ...pending, postStatus: undefined, posted: false, preview: undefined, previewKey: crypto.randomUUID(), postKey: crypto.randomUUID() };
                persistDraft(rejected); setDraft(rejected);
                const errorKey = code ? translatedDomainErrors[code] : undefined;
                setError(errorKey ? t(`loanDetail.accrualPayment.errors.${errorKey}`, "The payment was rejected. Review the draft and preview again.") : t("loanDetail.accrualPayment.errors.definitiveRejection", "The payment was rejected. Review the draft and preview again."));
            } else {
                // Retry identity is immutable even for authorization/not-found errors:
                // these can mask an already committed receipt after access changes.
                persistDraft(pending); setDraft(pending);
                const accessFailure = status === 401 || status === 403 || status === 404;
                setError(t(accessFailure ? "loanDetail.accrualPayment.errors.retryAccessRecovery" : "loanDetail.accrualPayment.errors.outcomeUnknown",
                    accessFailure ? "Access could not be verified. This saved payment may already be posted; restore access and retry this same payment." : "Payment status is unknown. Keep this draft and retry the same payment before starting another."));
            }
        }
        finally { setBusy(false); }
    };
    const refreshAfterPost = async () => { try { await onRefresh?.(); localStorage.removeItem(storageKey); setDraft(null); setRefreshFailed(false); setOpen(false); } catch { setRefreshFailed(true); } };
    const activeRows = rows.filter((row) => row.status !== "reversed");
    const total = sumAccrualMoney(activeRows.map((row) => row.interestAmount));
    const paid = sumAccrualMoney(activeRows.map((row) => row.paidAmount));
    const remaining = sumAccrualMoney(activeRows.map((row) => row.remainingAmount));
    const statusLabel = (status: string) => t(`loanDetail.accrualTable.statuses.${status}`, status);

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("loanDetail.accrualTable.title", "Accrual table")}</CardTitle>
                <CardDescription>{t("loanDetail.accrualTable.description", "Interest accrued for this agreement, including paid and remaining amounts.")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                {(isPosted || hasUnresolvedPost) && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-amber-500/40 bg-amber-500/5 p-3" role="status">
                    <span>{hasUnresolvedPost ? t("loanDetail.accrualPayment.recoveryPending", "A payment response was lost. Resolve this saved payment before creating another.") : t("loanDetail.accrualPayment.recoveryAvailable", "A posted receipt is saved and needs loan history recovery.")}{draft?.receiptPublicId ? ` · ${draft.receiptPublicId}` : draft?.paymentIntakePublicId ? ` · ${draft.paymentIntakePublicId}` : ""}</span>
                    <Button variant="outline" onClick={() => setOpen(true)}>{t("loanDetail.accrualPayment.continueRecovery", "Continue receipt recovery")}</Button>
                </div>}
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
                                <TableHead>{t("loanDetail.accrualPayment.history", "Receipts")}</TableHead>
                                <TableHead>{t("loanDetail.accrualPayment.action", "Action")}</TableHead>
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
                                    <TableCell className="min-w-52 text-sm">
                                        {(row.receiptHistory ?? []).length ? row.receiptHistory!.map((receipt, index) => <div key={`${receipt.transactionPublicId ?? receipt.sourceKind}-${index}`} className="mb-1 rounded border p-2">
                                            <div className="flex flex-wrap items-center gap-x-2"><strong>{formatMoneyExact(receipt.amount, i18n.language)}</strong><Badge variant={receipt.status === "reversed" ? "destructive" : "outline"}>{receipt.status === "reversed" ? t("loanDetail.accrualPayment.reversed", "Reversed receipt") : t(`loanDetail.accrualPayment.sources.${receipt.sourceKind}`, receipt.sourceKind)}</Badge></div>
                                            <div>{receipt.receivedAt ? t("loanDetail.accrualPayment.receivedAt", { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(receipt.receivedAt)) }) : receipt.sourceKind === "advance_deduction" ? t("loanDetail.accrualPayment.advanceNoReceipt", "Contractual advance; no receipt event") : t("loanDetail.accrualPayment.unknownTime", "Receipt time unavailable")}</div>
                                            {receipt.recordedAt && <div className="text-muted-foreground">{t("loanDetail.accrualPayment.recordedAt", { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(receipt.recordedAt)) })}</div>}
                                            {receipt.href && <Link className="text-primary underline" to={receipt.href}>{t("loanDetail.accrualPayment.openReceipt", "Open payment review")}</Link>}
                                        </div>) : row.status === "paid" ? <span>{t("loanDetail.accrualPayment.legacyUnknown", "Legacy payment details unavailable")}</span> : <span>—</span>}
                                    </TableCell>
                                    <TableCell>{canEdit && !isPosted && !hasUnresolvedPost && !refreshFailed && row.status !== "reversed" && new FinancialDecimal(row.remainingAmount).gt(0) && <Button size="sm" variant="outline" onClick={() => openPay(row)}>{t("loanDetail.accrualPayment.pay", "Pay")}</Button>}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </CardContent>
            <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }}>
                <DialogContent className="w-[calc(100vw-2rem)] max-h-[90dvh] max-w-2xl overflow-x-hidden overflow-y-auto">
                    <DialogHeader><DialogTitle>{t("loanDetail.accrualPayment.title", "Pay selected daily interest")}</DialogTitle><DialogDescription>{t("loanDetail.accrualPayment.description", "Choose accrued dates and record when the money was actually received.")}</DialogDescription></DialogHeader>
                    {isPosted ? <div className="space-y-3" role="status"><p>{t("loanDetail.accrualPayment.posted", "Payment posted. The receipt remains saved for safe recovery.")}</p><p>{t("loanDetail.accrualPayment.receiptIdentity", { receipt: draft?.receiptPublicId ?? draft?.paymentIntakePublicId ?? "—", audit: draft?.auditPublicId ?? "—", defaultValue: `Receipt ${draft?.receiptPublicId ?? draft?.paymentIntakePublicId ?? "—"}; audit ${draft?.auditPublicId ?? "—"}` })}</p><Button onClick={() => void refreshAfterPost()} disabled={busy}>{t("loanDetail.accrualPayment.refresh", "Refresh loan history")}</Button></div> : hasUnresolvedPost ? <div className="space-y-3" role="status"><p>{error || t("loanDetail.accrualPayment.errors.outcomeUnknown", "Payment status is unknown. Keep this draft and retry the same payment before starting another.")}</p><p>{t("loanDetail.accrualPayment.pendingIdentity", { intake: draft?.paymentIntakePublicId ?? "—", defaultValue: `Saved payment ${draft?.paymentIntakePublicId ?? "—"}` })}</p><Button onClick={() => void post()} disabled={busy}>{t("loanDetail.accrualPayment.retry", "Retry payment")}</Button></div> : draft && <div className="space-y-4">
                        <div className="grid gap-2 sm:grid-cols-2">{rows.filter((row) => row.status !== "reversed" && new FinancialDecimal(row.remainingAmount).gt(0)).map((row) => <label key={row.accrualDate} className="flex min-w-0 items-center gap-2 rounded border p-2 text-sm">
                            <input type="checkbox" disabled={busy} checked={row.accrualDate in draft.selected} onChange={(event) => { const selected = { ...draft.selected }; if (event.target.checked) selected[row.accrualDate] = row.remainingAmount; else delete selected[row.accrualDate]; change({ ...draft, selected }); }} />
                            <span className="min-w-0 flex-1">{formatDate(row.accrualDate, i18n.language)}</span>
                            {row.accrualDate in draft.selected && <Input disabled={busy} aria-label={t("loanDetail.accrualPayment.targetAmount", { date: row.accrualDate })} inputMode="decimal" maxLength={32} className="w-28" value={draft.selected[row.accrualDate]} onChange={(event) => change({ ...draft, selected: { ...draft.selected, [row.accrualDate]: event.target.value } })} />}
                        </label>)}</div>
                        <label className="grid gap-1 text-sm">{t("loanDetail.accrualPayment.receivedAtLabel", "Actual received time (Bangkok)")}<Input disabled={busy} type="datetime-local" value={draft.receivedAt} onChange={(event) => change({ ...draft, receivedAt: event.target.value })} /></label>
                        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">{t("loanDetail.accrualPayment.bankReference", "Bank reference (optional)")}<Input disabled={busy} maxLength={512} value={draft.bankReference ?? ""} onChange={(event) => change({ ...draft, bankReference: event.target.value })} /></label><label className="grid gap-1 text-sm">{t("loanDetail.accrualPayment.notes", "Note (optional)")}<Input disabled={busy} maxLength={4000} value={draft.notes ?? ""} onChange={(event) => change({ ...draft, notes: event.target.value })} /></label></div>
                        <div className="rounded border p-3 text-sm">{t("loanDetail.accrualPayment.total", "Receipt total")}: <strong>{formatMoneyExact(totalSelected, i18n.language)}</strong></div>
                        {draft.preview && <div className="rounded border p-3" role="status"><strong>{t("loanDetail.accrualPayment.review", "Review")}: {t(`payments.previewStatus.${draft.preview.status}`, draft.preview.status)}</strong>
                            {draft.preview.receivedAt && <p className="mt-2">{t("loanDetail.accrualPayment.receivedAt", { date: new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(draft.preview.receivedAt)) })}</p>}
                            <div className="mt-2 space-y-1 text-sm">{(draft.preview.targets ?? []).map((target) => <div key={target.accrualDate} className="flex justify-between gap-3"><span>{formatDate(target.accrualDate, i18n.language)} · {t("loanDetail.accrualPayment.debt.interest", "Interest")}</span><strong>{formatMoneyExact(target.amount, i18n.language)}</strong></div>)}</div>
                            <p className="mt-2">{t("loanDetail.accrualPayment.total", "Receipt total")}: <strong>{formatMoneyExact(draft.preview.totalAllocated ?? "0.00", i18n.language)}</strong> · {t("loanDetail.accrualPayment.variance", "Variance")}: <strong>{formatMoneyExact(new FinancialDecimal(totalSelected).minus(draft.preview.totalAllocated ?? "0.00").toFixed(2), i18n.language)}</strong></p>
                            {Boolean(draft.preview.warnings?.length) && <ul className="mt-2 list-disc pl-5">{draft.preview.warnings!.map((warning, index) => { const key = warning.code ? translatedWarnings[warning.code] : undefined; return <li key={`${warning.code ?? "generic"}-${index}`}>{t(key ? `loanDetail.accrualPayment.blockers.${key}` : "loanDetail.accrualPayment.blockers.generic", "Warnings or variance must be resolved before posting.")}</li>; })}</ul>}
                            {draft.preview.remainingDebt && <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">{(["principal", "fees", "interest", "penalty"] as const).map((part) => <div key={part}><dt>{t(`loanDetail.accrualPayment.debt.${part}`, part)}</dt><dd className="font-medium tabular-nums">{formatMoneyExact(draft.preview!.remainingDebt![part], i18n.language)}</dd></div>)}</dl>}</div>}
                        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                    </div>}
                    {isPosted ? <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>{t("common.close", "Close")}</Button></DialogFooter> : hasUnresolvedPost ? <DialogFooter><Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.close", "Close")}</Button></DialogFooter> : <DialogFooter className="flex-col sm:flex-row"><Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel", "Cancel")}</Button><Button variant="outline" onClick={() => void preview()} disabled={busy || !draft || Object.keys(draft.selected).length === 0}>{t("payments.preview", "Preview")}</Button>{draft?.preview?.status === "ready" && !draft.preview.warnings?.length && zeroVariance && <Button onClick={() => void post()} disabled={busy}>{t("loanDetail.accrualPayment.confirm", "Confirm payment")}</Button>}</DialogFooter>}
                </DialogContent>
            </Dialog>
        </Card>
    );
}
