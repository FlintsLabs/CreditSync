import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ArrowDownToLine, CheckCircle2, FileUp, RefreshCw, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { api } from "../../../lib/api";
import { Button } from "../../../components/ui/Button";
import { Card, CardContent, CardHeader, CardTitle } from "../../../components/ui/Card";
import { Input } from "../../../components/ui/Input";
import { Badge } from "../../../components/ui/badge";
import { normalizeMoney } from "../../../lib/workflow-api";

interface PaymentIntake {
    publicId: string;
    status: string;
    amount: string;
    receivedAt: string;
    payerName?: string | null;
    bankReference?: string | null;
    notes?: string | null;
    evidence?: Array<{ publicId: string; status: string; mimeType: string }>;
    latestProposal?: PaymentProposal | null;
}

interface PaymentProposal {
    publicId: string;
    status: string;
    version: number;
    totalAllocated: string;
    warnings: Array<{ code?: string; [key: string]: unknown }>;
    expiresAt: string;
    allocations: Array<{
        borrowerPublicId: string;
        loanPublicId: string;
        schedulePublicId?: string | null;
        amount: string;
    }>;
}

interface LoanOption {
    publicId: string;
    borrowerPublicId: string;
    borrowerName: string;
    status: string;
}

interface AuditEntry {
    id: number;
    action: string;
    requestId?: string | null;
    correlationId?: string | null;
    createdAt: string;
}

interface EvidenceIntent {
    publicId: string;
    status?: string;
    uploadUrl?: string;
    requiredHeaders?: Record<string, string>;
    duplicate?: boolean;
}

function hex(bytes: ArrayBuffer) {
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default function PaymentInbox() {
    const { t, i18n } = useTranslation();
    const [items, setItems] = useState<PaymentIntake[]>([]);
    const [loans, setLoans] = useState<LoanOption[]>([]);
    const [selectedId, setSelectedId] = useState("");
    const [detail, setDetail] = useState<PaymentIntake | null>(null);
    const [audits, setAudits] = useState<AuditEntry[]>([]);
    const [loanId, setLoanId] = useState("");
    const [scheduleId, setScheduleId] = useState("");
    const [allocationAmount, setAllocationAmount] = useState("");
    const [proposal, setProposal] = useState<PaymentProposal | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const money = useCallback((value: string | number) => new Intl.NumberFormat(i18n.language, {
        style: "currency", currency: "THB", minimumFractionDigits: 2,
    }).format(Number(value)), [i18n.language]);
    const dateTime = useCallback((value: string) => new Intl.DateTimeFormat(i18n.language, {
        dateStyle: "medium", timeStyle: "short",
    }).format(new Date(value)), [i18n.language]);

    const loadList = useCallback(async () => {
        const [intakes, loanRows] = await Promise.all([api.get("/payment-intakes"), api.get("/loans")]);
        setItems(intakes.data ?? []);
        setLoans((loanRows.data ?? []).filter((loan: LoanOption) => loan.status === "active"));
    }, []);

    const loadDetail = useCallback(async (publicId: string) => {
        const response = await api.get(`/payment-intakes/${publicId}`);
        const next = response.data as PaymentIntake;
        setDetail(next);
        setProposal(next.latestProposal ?? null);
        setAllocationAmount(next.amount);
        const previous = next.latestProposal?.allocations[0];
        setLoanId(previous?.loanPublicId ?? "");
        setScheduleId(previous?.schedulePublicId ?? "");
        try {
            const history = await api.get("/audit-logs", { params: { entityType: "payment_intake", entityId: publicId } });
            setAudits(history.data ?? []);
        } catch {
            setAudits([]);
        }
    }, []);

    useEffect(() => { void loadList().catch(() => setMessage(t("payments.errors.load"))); }, [loadList, t]);
    useEffect(() => { if (selectedId) void loadDetail(selectedId).catch(() => setMessage(t("payments.errors.loadDetail"))); }, [loadDetail, selectedId, t]);

    const selectedLoan = loans.find((loan) => loan.publicId === loanId);
    const oldAmount = Number(detail?.latestProposal?.totalAllocated ?? 0);
    const newAmount = Number(proposal?.totalAllocated ?? (allocationAmount || "0"));
    const canEdit = detail && !["posted", "reversed", "duplicate"].includes(detail.status);

    const mutate = async (operation: () => Promise<void>) => {
        setBusy(true);
        setMessage("");
        try {
            await operation();
            await Promise.all([loadList(), selectedId ? loadDetail(selectedId) : Promise.resolve()]);
        } catch (error: unknown) {
            const apiError = error as { response?: { data?: { error?: string } } };
            setMessage(apiError.response?.data?.error ?? t("payments.errors.action"));
        } finally {
            setBusy(false);
        }
    };

    const preview = () => mutate(async () => {
        if (!selectedLoan) throw new Error("Loan is required");
        const response = await api.post(`/payment-intakes/${selectedId}/match-preview`, {
            allocations: [{
                borrowerPublicId: selectedLoan.borrowerPublicId,
                loanPublicId: selectedLoan.publicId,
                ...(scheduleId.trim() ? { schedulePublicId: scheduleId.trim() } : {}),
                amount: normalizeMoney(allocationAmount),
            }],
        });
        setProposal(response.data);
    });

    const uploadEvidence = (file: File) => mutate(async () => {
        const digest = hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
        const intent = await api.post(`/payment-intakes/${selectedId}/evidence/upload-intents`, {
            mimeType: file.type,
            size: file.size,
            sha256: digest,
            evidenceType: "slip",
        }).then((response) => response.data as EvidenceIntent);
        if (intent.duplicate) return;
        if (intent.status !== "ready" && intent.uploadUrl) {
            const upload = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.requiredHeaders, body: file });
            if (!upload.ok) throw new Error("Evidence upload failed");
        }
        await api.post(`/payment-intakes/${selectedId}/evidence/${intent.publicId}/finalize`);
    });

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-3xl font-bold">{t("payments.title")}</h1>
                    <p className="text-muted-foreground">{t("payments.description")}</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" onClick={() => void loadList()}><RefreshCw className="mr-2 h-4 w-4" />{t("common.refresh")}</Button>
                    <Link to="/transactions/new" className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"><ArrowDownToLine className="mr-2 h-4 w-4" />{t("payments.new")}</Link>
                </div>
            </div>
            {message && <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{message}</div>}
            <div className="grid gap-5 xl:grid-cols-[0.85fr_1.4fr]">
                <Card>
                    <CardHeader><CardTitle>{t("payments.inbox")}</CardTitle></CardHeader>
                    <CardContent className="space-y-2">
                        {items.map((item) => (
                            <button key={item.publicId} onClick={() => setSelectedId(item.publicId)} className={`w-full rounded border p-3 text-left ${selectedId === item.publicId ? "border-primary bg-primary/5" : "hover:bg-muted/30"}`}>
                                <div className="flex items-center justify-between gap-3"><span className="font-medium">{item.payerName || t("payments.unknownPayer")}</span><Badge variant={item.status === "needs_review" ? "destructive" : "secondary"}>{t(`payments.status.${item.status}`)}</Badge></div>
                                <div className="mt-1 flex justify-between text-sm text-muted-foreground"><span>{dateTime(item.receivedAt)}</span><span>{money(item.amount)}</span></div>
                            </button>
                        ))}
                        {!items.length && <div className="rounded border border-dashed p-6 text-center text-muted-foreground">{t("payments.empty")}</div>}
                    </CardContent>
                </Card>
                {!detail ? <Card><CardContent className="py-16 text-center text-muted-foreground">{t("payments.select")}</CardContent></Card> : (
                    <div className="space-y-5">
                        <Card>
                            <CardHeader><CardTitle className="flex items-center justify-between gap-3"><span>{t("payments.review")}</span><Badge>{t(`payments.status.${detail.status}`)}</Badge></CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                {detail.status === "duplicate" && <div className="flex gap-2 rounded border border-amber-400/40 bg-amber-400/10 p-3 text-sm"><AlertTriangle className="h-4 w-4" />{t("payments.duplicateWarning")}</div>}
                                <dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-muted-foreground">{t("payments.amount")}</dt><dd className="font-medium">{money(detail.amount)}</dd></div><div><dt className="text-muted-foreground">{t("payments.reference")}</dt><dd>{detail.bankReference || "—"}</dd></div><div className="sm:col-span-2"><dt className="text-muted-foreground">{t("payments.intakeId")}</dt><dd className="break-all font-mono text-xs">{detail.publicId}</dd></div></dl>
                                {canEdit && <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => mutate(async () => { await api.post(`/payment-intakes/${selectedId}/review`, { status: "needs_review", notes: detail.notes ?? null }); })}>{t("payments.markReview")}</Button><label className="inline-flex cursor-pointer items-center rounded border px-3 py-1.5 text-sm"><FileUp className="mr-2 h-4 w-4" />{t("payments.addEvidence")}<input type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadEvidence(file); }} /></label></div>}
                                {!!detail.evidence?.length && <div className="space-y-1">{detail.evidence.map((item) => <div key={item.publicId} className="rounded bg-muted/40 p-2 text-xs">{item.mimeType} · {t(`payments.status.${item.status}`)} · <span className="font-mono">{item.publicId}</span></div>)}</div>}
                            </CardContent>
                        </Card>
                        <Card>
                            <CardHeader><CardTitle>{t("payments.allocation")}</CardTitle></CardHeader>
                            <CardContent className="space-y-4">
                                <div className="grid gap-3 md:grid-cols-2"><label className="grid gap-1 text-sm">{t("payments.loan")}<select className="h-10 rounded border bg-background px-3" value={loanId} disabled={!canEdit} onChange={(event) => setLoanId(event.target.value)}><option value="">{t("payments.selectLoan")}</option>{loans.map((loan) => <option key={loan.publicId} value={loan.publicId}>{loan.borrowerName} · {loan.publicId.slice(0, 8)}</option>)}</select></label><label className="grid gap-1 text-sm">{t("payments.allocationAmount")}<Input value={allocationAmount} disabled={!canEdit} onChange={(event) => setAllocationAmount(event.target.value)} /></label><label className="grid gap-1 text-sm md:col-span-2">{t("payments.scheduleId")}<Input value={scheduleId} disabled={!canEdit} placeholder={t("payments.optionalUuid")} onChange={(event) => setScheduleId(event.target.value)} /></label></div>
                                {proposal && <div className="rounded border p-3 text-sm"><div className="flex items-center justify-between"><span>{t("payments.previewVersion", { version: proposal.version })}</span><Badge variant={proposal.status === "ready" ? "default" : "destructive"}>{t(`payments.status.${proposal.status}`)}</Badge></div><div className="mt-2 grid gap-2 sm:grid-cols-3"><div><span className="text-muted-foreground">{t("payments.previous")}</span><div>{money(oldAmount)}</div></div><div><span className="text-muted-foreground">{t("payments.previewTotal")}</span><div>{money(newAmount)}</div></div><div><span className="text-muted-foreground">{t("payments.difference")}</span><div className={newAmount - oldAmount === 0 ? "" : "text-amber-600"}>{money(newAmount - oldAmount)}</div></div></div>{proposal.warnings.map((warning, index) => <div key={`${warning.code}-${index}`} className="mt-2 flex gap-2 text-amber-600"><AlertTriangle className="h-4 w-4" />{t(`payments.warnings.${warning.code}`, { defaultValue: warning.code })}</div>)}</div>}
                                <div className="flex flex-wrap gap-2">{canEdit && <Button onClick={() => void preview()} disabled={busy || !loanId}>{t("payments.preview")}</Button>}{proposal?.status === "ready" && canEdit && <Button className="bg-emerald-600 hover:bg-emerald-700" disabled={busy} onClick={() => mutate(async () => { await api.post(`/payment-intakes/${selectedId}/post`, { proposalPublicId: proposal.publicId }); })}><CheckCircle2 className="mr-2 h-4 w-4" />{t("payments.post")}</Button>}{detail.status === "posted" && <Button variant="destructive" disabled={busy} onClick={() => mutate(async () => { await api.post(`/payment-intakes/${selectedId}/reverse`); })}><RotateCcw className="mr-2 h-4 w-4" />{t("payments.reverse")}</Button>}</div>
                            </CardContent>
                        </Card>
                        <Card><CardHeader><CardTitle>{t("payments.audit")}</CardTitle></CardHeader><CardContent className="space-y-2">{audits.map((audit) => <div key={audit.id} className="rounded border p-3 text-sm"><div className="flex justify-between"><span className="font-medium">{audit.action}</span><span className="text-muted-foreground">{dateTime(audit.createdAt)}</span></div><div className="mt-1 break-all font-mono text-xs text-muted-foreground">{t("payments.auditId")}: {audit.id} · {t("payments.correlationId")}: {audit.correlationId || "—"} · {t("payments.requestId")}: {audit.requestId || "—"}</div></div>)}{!audits.length && <div className="text-sm text-muted-foreground">{t("payments.auditUnavailable")}</div>}</CardContent></Card>
                    </div>
                )}
            </div>
        </div>
    );
}
