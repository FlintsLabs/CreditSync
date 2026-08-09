import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDownToLine, CheckCircle2, FileUp, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";
import {
    formatMoneyExact,
    moneyDifference,
    sumMoney,
    toExplicitAllocations,
    type AllocationDraft,
} from "../../../lib/workflow-model";

interface WorkflowWarning { code: string; intakePublicIds?: string[]; [key: string]: unknown }
interface PaymentProposal {
    publicId: string; status: string; version: number; totalAllocated: string;
    warnings: WorkflowWarning[]; expiresAt: string;
    allocations: Array<{ borrowerPublicId: string; loanPublicId: string; schedulePublicId?: string | null; amount: string }>;
}
interface PaymentIntake {
    publicId: string; status: string; amount: string; receivedAt: string;
    payerName?: string | null; bankReference?: string | null; notes?: string | null;
    warnings?: WorkflowWarning[];
    evidence?: Array<{ publicId: string; status: string; mimeType: string }>;
    latestProposal?: PaymentProposal | null;
}
interface LoanOption { publicId: string; borrowerPublicId: string; borrowerName: string; status: string }
interface AuditEntry { id: number; action: string; requestId?: string | null; correlationId?: string | null; createdAt: string }
interface EvidenceIntent { publicId: string; status?: string; uploadUrl?: string; requiredHeaders?: Record<string, string>; duplicate?: boolean }
type AuditState = { status: "idle" | "loading" | "empty" | "forbidden" | "error" } | { status: "ready"; entries: AuditEntry[] };

function newAllocation(amount = ""): AllocationDraft {
    return { id: crypto.randomUUID(), borrowerPublicId: "", loanPublicId: "", schedulePublicId: "", amount };
}

function hex(bytes: ArrayBuffer) {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function PaymentInbox() {
    const { t, i18n } = useTranslation();
    const [searchParams] = useSearchParams();
    const [items, setItems] = useState<PaymentIntake[]>([]);
    const [loans, setLoans] = useState<LoanOption[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [detail, setDetail] = useState<PaymentIntake | null>(null);
    const [baselineProposal, setBaselineProposal] = useState<PaymentProposal | null>(null);
    const [proposal, setProposal] = useState<PaymentProposal | null>(null);
    const [allocations, setAllocations] = useState<AllocationDraft[]>([newAllocation()]);
    const [audit, setAudit] = useState<AuditState>({ status: "idle" });
    const [listLoading, setListLoading] = useState(true);
    const [detailLoading, setDetailLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [semanticReviewed, setSemanticReviewed] = useState(false);
    const [reversalOpen, setReversalOpen] = useState(false);
    const [reversalReason, setReversalReason] = useState("");
    const [editorRevision, setEditorRevision] = useState(0);
    const [proposalRevision, setProposalRevision] = useState<number | null>(null);
    const selectionToken = useRef(0);
    const loansRef = useRef<LoanOption[]>([]);
    const editorRevisionRef = useRef(0);

    const money = useCallback((value: string) => formatMoneyExact(value, i18n.language), [i18n.language]);
    const dateTime = useCallback((value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium", timeStyle: "short",
    }).format(new Date(value)), [i18n.language]);
    const localizedError = useCallback((error: unknown, fallbackKey: string) => {
        const response = (error as { response?: { data?: { code?: string }; status?: number } }).response;
        return response?.data?.code
            ? t(`domainErrors.${response.data.code}`, { defaultValue: t(fallbackKey) })
            : t(fallbackKey);
    }, [t]);

    const loadList = useCallback(async () => {
        setListLoading(true);
        try {
            const [intakes, loanRows] = await Promise.all([api.get("/payment-intakes"), api.get("/loans")]);
            setItems(intakes.data ?? []);
            const activeLoans = (loanRows.data ?? []).filter((loan: LoanOption) => loan.status === "active");
            loansRef.current = activeLoans;
            setLoans(activeLoans);
        } finally { setListLoading(false); }
    }, []);

    const selectIntake = useCallback(async (publicId: string) => {
        const token = ++selectionToken.current;
        setSelectedId(publicId);
        setDetail(null);
        setBaselineProposal(null);
        setProposal(null);
        editorRevisionRef.current += 1;
        setEditorRevision(editorRevisionRef.current);
        setProposalRevision(null);
        setAllocations([newAllocation()]);
        setSemanticReviewed(false);
        setReversalOpen(false);
        setReversalReason("");
        setDetailLoading(true);
        setMessage("");
        setAudit({ status: "loading" });
        try {
            const response = await api.get(`/payment-intakes/${publicId}`);
            if (selectionToken.current !== token) return;
            const next = response.data as PaymentIntake;
            setDetail(next);
            setBaselineProposal(next.latestProposal ?? null);
            const existing = next.latestProposal?.allocations ?? [];
            const suggestedLoanId = searchParams.get("loanId") ?? "";
            const suggestedLoan = loansRef.current.find((loan) => loan.publicId === suggestedLoanId);
            setAllocations(existing.length ? existing.map((row) => ({
                id: crypto.randomUUID(), borrowerPublicId: row.borrowerPublicId,
                loanPublicId: row.loanPublicId, schedulePublicId: row.schedulePublicId ?? "", amount: row.amount,
            })) : [suggestedLoan ? {
                id: crypto.randomUUID(), borrowerPublicId: suggestedLoan.borrowerPublicId,
                loanPublicId: suggestedLoan.publicId, schedulePublicId: searchParams.get("scheduleId") ?? "", amount: next.amount,
            } : newAllocation(next.amount)]);
        } catch (error) {
            if (selectionToken.current === token) setMessage(localizedError(error, "payments.errors.loadDetail"));
        } finally {
            if (selectionToken.current === token) setDetailLoading(false);
        }
        try {
            const history = await api.get("/audit-logs", { params: { entityType: "payment_intake", entityId: publicId } });
            if (selectionToken.current !== token) return;
            const entries = history.data ?? [];
            setAudit(entries.length ? { status: "ready", entries } : { status: "empty" });
        } catch (error) {
            if (selectionToken.current !== token) return;
            const status = (error as { response?: { status?: number } }).response?.status;
            setAudit({ status: status === 403 ? "forbidden" : "error" });
        }
    }, [localizedError, searchParams]);

    useEffect(() => {
        void Promise.resolve().then(loadList).then(() => {
            const requested = searchParams.get("intake");
            if (requested) void selectIntake(requested);
        }).catch((error) => setMessage(localizedError(error, "payments.errors.load")));
    }, [loadList, localizedError, searchParams, selectIntake]);

    const mutate = async (operation: () => Promise<void>, reloadDetail = true) => {
        if (!detail) return;
        setBusy(true); setMessage("");
        try {
            await operation();
            await loadList();
            if (reloadDetail) await selectIntake(detail.publicId);
        } catch (error) { setMessage(localizedError(error, "payments.errors.action")); }
        finally { setBusy(false); }
    };

    const updateAllocations = (update: (current: AllocationDraft[]) => AllocationDraft[]) => {
        editorRevisionRef.current += 1;
        setEditorRevision(editorRevisionRef.current);
        setProposalRevision(null);
        setProposal(null);
        setAllocations(update);
    };
    const editAllocation = (id: string, patch: Partial<AllocationDraft>) => {
        updateAllocations((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
    };
    const enteredTotal = (() => { try { return sumMoney(allocations.map((row) => row.amount || "0.00")); } catch { return "0.00"; } })();
    const previousTotal = baselineProposal?.totalAllocated ?? "0.00";
    const previewTotal = proposal?.totalAllocated ?? enteredTotal;
    const difference = moneyDifference(previewTotal, previousTotal);
    const semanticWarnings = detail?.warnings?.filter((warning) => warning.code === "POSSIBLE_SEMANTIC_DUPLICATE") ?? [];
    const canEdit = Boolean(detail && !detailLoading && !busy && !["posted", "reversed", "duplicate"].includes(detail.status));
    const proposalMatchesEditor = Boolean(proposal && proposalRevision === editorRevision);

    const preview = () => {
        const revision = editorRevisionRef.current;
        const snapshot = toExplicitAllocations(allocations);
        return mutate(async () => {
        const response = await api.post(`/payment-intakes/${detail!.publicId}/match-preview`, {
            allocations: snapshot,
        });
        if (editorRevisionRef.current !== revision) return;
        setProposalRevision(revision);
        setProposal(response.data);
        }, false);
    };

    const refreshList = async () => {
        setMessage("");
        try { await loadList(); }
        catch (error) { setMessage(localizedError(error, "payments.errors.load")); }
    };

    const uploadEvidence = (file: File) => mutate(async () => {
        const digest = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
        const intent = await api.post(`/payment-intakes/${detail!.publicId}/evidence/upload-intents`, {
            mimeType: file.type, size: file.size, sha256: digest, evidenceType: "slip",
        }).then((response) => response.data as EvidenceIntent);
        if (intent.duplicate) return;
        if (intent.status !== "ready" && intent.uploadUrl) {
            const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.requiredHeaders, body: file });
            if (!upload.ok) throw new Error("EVIDENCE_UPLOAD_FAILED");
        }
        await api.post(`/payment-intakes/${detail!.publicId}/evidence/${intent.publicId}/finalize`);
    });

    return <div className="space-y-6" aria-busy={listLoading || detailLoading || busy}>
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h1 className="text-3xl font-bold">{t("payments.title")}</h1><p className="text-muted-foreground">{t("payments.description")}</p></div>
            <div className="flex gap-2"><Button variant="outline" disabled={listLoading} onClick={() => void refreshList()}><RefreshCw className="mr-2 h-4 w-4" />{listLoading ? t("common.loading") : t("common.refresh")}</Button><Link to="/transactions/new" className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"><ArrowDownToLine className="mr-2 h-4 w-4" />{t("payments.new")}</Link></div>
        </div>
        {message && <div role="alert" className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{message}</div>}
        <div className="grid gap-5 xl:grid-cols-[0.85fr_1.4fr]">
            <Card><CardHeader><CardTitle>{t("payments.inbox")}</CardTitle></CardHeader><CardContent className="space-y-2">
                {listLoading ? <div role="status" className="p-6 text-center text-muted-foreground">{t("common.loading")}</div> : items.map((item) => <button key={item.publicId} onClick={() => void selectIntake(item.publicId)} className={`w-full rounded border p-3 text-left ${selectedId === item.publicId ? "border-primary bg-primary/5" : "hover:bg-muted/30"}`}><div className="flex justify-between gap-3"><span className="font-medium">{item.payerName || t("payments.unknownPayer")}</span><Badge variant={item.status === "needs_review" ? "destructive" : "secondary"}>{t(`payments.status.${item.status}`)}</Badge></div><div className="mt-1 flex justify-between text-sm text-muted-foreground"><span>{dateTime(item.receivedAt)}</span><span>{money(item.amount)}</span></div></button>)}
                {!listLoading && !items.length && <div className="rounded border border-dashed p-6 text-center text-muted-foreground">{t("payments.empty")}</div>}
            </CardContent></Card>
            {detailLoading ? <Card><CardContent role="status" className="py-16 text-center text-muted-foreground">{t("payments.loadingDetail")}</CardContent></Card> : !detail ? <Card><CardContent className="py-16 text-center text-muted-foreground">{t("payments.select")}</CardContent></Card> : <div className="space-y-5">
                <Card><CardHeader><CardTitle className="flex justify-between"><span>{t("payments.review")}</span><Badge>{t(`payments.status.${detail.status}`)}</Badge></CardTitle></CardHeader><CardContent className="space-y-4">
                    {detail.status === "duplicate" && <div role="alert" className="flex gap-2 rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm"><AlertTriangle className="h-4 w-4" />{t("payments.duplicateWarning")}</div>}
                    {semanticWarnings.map((warning) => <div role="alert" key={warning.code} className="rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm"><div className="flex gap-2 font-medium"><AlertTriangle className="h-4 w-4" />{t("payments.warnings.POSSIBLE_SEMANTIC_DUPLICATE")}</div><div className="mt-1 break-all font-mono text-xs">{warning.intakePublicIds?.join(", ")}</div><label className="mt-2 flex gap-2"><input type="checkbox" checked={semanticReviewed} onChange={(event) => setSemanticReviewed(event.target.checked)} />{t("payments.semanticReviewConfirmation")}</label></div>)}
                    <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t("payments.amount")}</dt><dd>{money(detail.amount)}</dd></div><div><dt className="text-muted-foreground">{t("payments.reference")}</dt><dd>{detail.bankReference || "—"}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">{t("payments.intakeId")}</dt><dd className="break-all font-mono text-xs">{detail.publicId}</dd></div></dl>
                    {canEdit && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void mutate(async () => { await api.post(`/payment-intakes/${detail.publicId}/review`, { status: "needs_review", notes: detail.notes ?? null }); })}>{t("payments.markReview")}</Button><label className="inline-flex cursor-pointer items-center rounded border px-3 py-1.5 text-sm"><FileUp className="mr-2 h-4 w-4" />{t("payments.addEvidence")}<input type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadEvidence(file); }} /></label></div>}
                    {!!detail.evidence?.length && detail.evidence.map((item) => <div key={item.publicId} className="rounded bg-muted/40 p-2 text-xs">{item.mimeType} · {t(`payments.status.${item.status}`)} · <span className="font-mono">{item.publicId}</span></div>)}
                </CardContent></Card>
                <Card><CardHeader><CardTitle>{t("payments.allocation")}</CardTitle></CardHeader><CardContent className="space-y-4">
                    {allocations.map((row, index) => <div data-testid="allocation-row" key={row.id} className="grid gap-3 rounded border p-3 md:grid-cols-2">
                        <label htmlFor={`loan-${row.id}`} className="grid gap-1 text-sm">{t("payments.loan")}<select id={`loan-${row.id}`} className="h-10 rounded border bg-background px-3" value={row.loanPublicId} disabled={!canEdit} onChange={(event) => { const loan = loans.find((candidate) => candidate.publicId === event.target.value); editAllocation(row.id, { loanPublicId: event.target.value, borrowerPublicId: loan?.borrowerPublicId ?? "" }); }}><option value="">{t("payments.selectLoan")}</option>{loans.map((loan) => <option key={loan.publicId} value={loan.publicId}>{loan.borrowerName} · {loan.publicId.slice(0, 8)}</option>)}</select></label>
                        <label htmlFor={`amount-${row.id}`} className="grid gap-1 text-sm">{t("payments.allocationAmount")}<Input id={`amount-${row.id}`} value={row.amount} disabled={!canEdit} onChange={(event) => editAllocation(row.id, { amount: event.target.value })} /></label>
                        <label htmlFor={`schedule-${row.id}`} className="grid gap-1 text-sm md:col-span-2">{t("payments.scheduleId")}<Input id={`schedule-${row.id}`} value={row.schedulePublicId ?? ""} disabled={!canEdit} placeholder={t("payments.optionalUuid")} onChange={(event) => editAllocation(row.id, { schedulePublicId: event.target.value })} /></label>
                        {allocations.length > 1 && <Button aria-label={t("payments.removeAllocation", { index: index + 1 })} size="sm" variant="outline" disabled={!canEdit} onClick={() => updateAllocations((current) => current.filter((candidate) => candidate.id !== row.id))}><Trash2 className="mr-2 h-4 w-4" />{t("payments.removeAllocation")}</Button>}
                    </div>)}
                    {canEdit && <Button size="sm" variant="outline" onClick={() => updateAllocations((current) => [...current, newAllocation()])}><Plus className="mr-2 h-4 w-4" />{t("payments.addAllocation")}</Button>}
                    <div className="rounded border p-3 text-sm"><div className="grid gap-2 sm:grid-cols-3"><div><span className="text-muted-foreground">{t("payments.previous")}</span><div>{money(previousTotal)}</div></div><div><span className="text-muted-foreground">{proposal ? t("payments.previewTotal") : t("payments.enteredTotal")}</span><div>{money(previewTotal)}</div></div><div><span className="text-muted-foreground">{t("payments.difference")}</span><div>{money(difference)}</div></div></div>{proposal && <div className="mt-2"><Badge variant={proposal.status === "ready" ? "default" : "destructive"}>{t(`payments.status.${proposal.status}`)}</Badge>{proposal.warnings.map((warning) => <div key={warning.code} className="mt-2 text-amber-600">{t(`payments.warnings.${warning.code}`, { defaultValue: t("payments.warnings.UNKNOWN") })}</div>)}</div>}</div>
                    <div className="flex flex-wrap gap-2">{canEdit && <Button disabled={allocations.some((row) => !row.loanPublicId || !row.borrowerPublicId || !row.amount)} onClick={() => void preview()}>{t("payments.preview")}</Button>}{proposalMatchesEditor && proposal?.status === "ready" && canEdit && (semanticWarnings.length === 0 || semanticReviewed) && <Button className="bg-emerald-600 hover:bg-emerald-700" onClick={() => void mutate(async () => { await api.post(`/payment-intakes/${detail.publicId}/post`, { proposalPublicId: proposal.publicId }); })}><CheckCircle2 className="mr-2 h-4 w-4" />{t("payments.post")}</Button>}{detail.status === "posted" && !reversalOpen && <Button variant="destructive" onClick={() => setReversalOpen(true)}><RotateCcw className="mr-2 h-4 w-4" />{t("payments.reverse")}</Button>}</div>
                    {reversalOpen && <div className="rounded border border-destructive/30 p-3"><label htmlFor="payment-reversal-reason" className="grid gap-1 text-sm">{t("payments.reversalReason")}<Input id="payment-reversal-reason" value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} /></label><div className="mt-3 flex gap-2"><Button variant="outline" onClick={() => setReversalOpen(false)}>{t("common.cancel")}</Button><Button variant="destructive" disabled={busy || !reversalReason.trim()} onClick={() => void mutate(async () => { await api.post(`/payment-intakes/${detail.publicId}/reverse`, { reason: reversalReason.trim() }); })}>{t("payments.confirmReverse")}</Button></div></div>}
                </CardContent></Card>
                <Card><CardHeader><CardTitle>{t("payments.audit")}</CardTitle></CardHeader><CardContent aria-live="polite">{audit.status === "loading" && <div role="status">{t("common.loading")}</div>}{audit.status === "empty" && <div>{t("payments.auditEmpty")}</div>}{audit.status === "forbidden" && <div>{t("payments.auditForbidden")}</div>}{audit.status === "error" && <div role="alert">{t("payments.auditFailed")}</div>}{audit.status === "ready" && <div className="space-y-2">{audit.entries.map((entry) => <div key={entry.id} className="rounded border p-3 text-sm"><div className="flex justify-between"><span>{t(`auditActions.${entry.action}`, { defaultValue: t("auditActions.unknown") })}</span><span>{dateTime(entry.createdAt)}</span></div><div className="mt-1 break-all font-mono text-xs text-muted-foreground">{t("payments.auditId")}: {entry.id} · {t("payments.correlationId")}: {entry.correlationId || "—"} · {t("payments.requestId")}: {entry.requestId || "—"}</div></div>)}</div>}</CardContent></Card>
            </div>}
        </div>
    </div>;
}
